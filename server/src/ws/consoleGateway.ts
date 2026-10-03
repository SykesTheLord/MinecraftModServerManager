import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { RequestHandler, Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { userRepo } from "../db/repositories/userRepo.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { hasInstanceRole } from "../auth/userService.js";
import { followContainerLogs } from "../docker/logsStream.js";
import { describeRconError, sendConsoleCommand } from "../rcon/rconClient.js";
import { writeConsoleLine } from "../docker/consoleInput.js";
import { getStartupQuery } from "../instances/healthPoller.js";
import { instanceService } from "../instances/instanceService.js";
import { HttpError } from "../http/errors.js";
import { isCrossOriginBrowserRequest, isFromInstanceNetwork } from "../http/security.js";
import { sessionStore } from "../auth/sessionStore.js";

const ROUTE_PATTERN = /^\/ws\/instances\/([^/]+)\/console$/;
/** How often an open console re-checks that its session and access still stand. */
const REAUTH_INTERVAL_MS = 30_000;
/** Close codes the browser treats as final (no reconnect): the session ended, or access was taken away. */
export const CLOSE_SESSION_ENDED = 4401;
export const CLOSE_ACCESS_REVOKED = 4403;

/**
 * Whether the connection's session still exists (not logged out, revoked by a
 * password change or user deletion, or idled out) and its user still has
 * operator access to the instance.
 */
function checkAccess(sessionId: string, userId: string, instanceId: string): Promise<number | null> {
  return new Promise((resolve) => {
    sessionStore.get(sessionId, (err, data) => {
      if (err || !data || (data as { userId?: string }).userId !== userId) return resolve(CLOSE_SESSION_ENDED);
      const user = userRepo.findById(userId);
      if (!user) return resolve(CLOSE_SESSION_ENDED);
      resolve(hasInstanceRole(user, instanceId, "operator") ? null : CLOSE_ACCESS_REVOKED);
    });
  });
}

export function attachConsoleGateway(server: HttpServer, sessionMiddleware: RequestHandler): void {
  // Console commands are one line of text; ws's 100 MiB default is just a memory-exhaustion lever.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    const match = ROUTE_PATTERN.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const instanceId = match[1];

    // Browsers attach cookies to WebSocket handshakes from other pages on
    // the same site, and CORS doesn't apply to WebSockets — without this any
    // sibling-subdomain page could drive a logged-in operator's RCON console.
    if (isFromInstanceNetwork(req.socket.remoteAddress) || isCrossOriginBrowserRequest(req.headers)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    sessionMiddleware(req as Request, {} as Response, () => {
      const userId = (req as Request).session?.userId;
      const user = userId ? userRepo.findById(userId) : undefined;
      if (!user || !hasInstanceRole(user, instanceId, "operator")) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const sessionId = (req as Request).sessionID;
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, instanceId, () => checkAccess(sessionId, user.id, instanceId));
      });
    });
  });
}

/**
 * Access is checked at the handshake, but a console can stay open for hours:
 * re-check it before every command and periodically, so logging out, a
 * password change, user deletion or revoked access cut an open console off
 * too, rather than leaving its RCON access usable until the tab closes.
 */
function handleConnection(ws: WebSocket, instanceId: string, checkStillAllowed: () => Promise<number | null>): void {
  const instance = instanceRepo.findById(instanceId);
  if (!instance || !instance.container_id) {
    ws.send(JSON.stringify({ type: "error", message: "Instance has no container yet." }));
    ws.close(1000);
    return;
  }

  const send = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  // Follows across container restarts (see followContainerLogs), so the live
  // console keeps working after a stop/start or a Docker-initiated relaunch
  // without the browser having to reconnect.
  const logSubscription = followContainerLogs(instance.container_id, (line) => send({ type: "log", line }), {
    tail: 200,
  });
  const closeIfRevoked = async (): Promise<boolean> => {
    const code = await checkStillAllowed();
    if (code === null) return false;
    ws.close(code, code === CLOSE_SESSION_ENDED ? "Session ended." : "Access revoked.");
    return true;
  };
  const reauthTimer = setInterval(() => void closeIfRevoked(), REAUTH_INTERVAL_MS);
  ws.on("close", () => {
    clearInterval(reauthTimer);
    logSubscription.stop();
  });

  ws.on("message", (raw) => {
    let payload: { type?: string; command?: string };
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (payload.type !== "command" || typeof payload.command !== "string" || !payload.command) return;
    const command = payload.command;

    const run = async () => {
      if (await closeIfRevoked()) return;
      // Answering Forge's startup question by hand works just like the buttons on the server page.
      const answer = /^\/?fml\s+(confirm|cancel)$/i.exec(command.trim())?.[1]?.toLowerCase() as "confirm" | "cancel" | undefined;
      if (answer && getStartupQuery(instanceId)) {
        await instanceService.answerStartupQuery(instanceId, answer);
        send({
          type: "response",
          response:
            answer === "confirm"
              ? "Answered Forge: confirm. It removes the missing entries and carries on starting."
              : "Answered Forge: cancel. Startup is aborted and the server is being stopped.",
        });
        return;
      }
      try {
        send({ type: "response", response: await sendConsoleCommand(instance.container_name, instance.rcon_password, command) });
      } catch (err) {
        const current = instanceRepo.findById(instanceId);
        // RCON only opens once the server has started; until then, type into its console input instead.
        if ((err as { code?: string }).code === "ECONNREFUSED" && current?.status === "installing" && current.container_id) {
          await writeConsoleLine(current.container_id, command);
          send({ type: "response", response: "(Typed into the server's console — it's still starting, so replies only show in the log.)" });
          return;
        }
        // The instance's current status says whether "refused" means "still starting" or "not running".
        send({ type: "error", message: describeRconError(err, current?.status ?? "") });
      }
    };
    run().catch((err: unknown) =>
      send({ type: "error", message: err instanceof HttpError ? err.message : `The command couldn't be sent: ${(err as Error).message}` })
    );
  });
}
