import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { RequestHandler, Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { userRepo } from "../db/repositories/userRepo.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { hasInstanceRole } from "../auth/userService.js";
import { followContainerLogs } from "../docker/logsStream.js";
import { sendConsoleCommand } from "../rcon/rconClient.js";
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

    closeIfRevoked()
      .then((revoked) => (revoked ? undefined : sendConsoleCommand(instance.container_name, instance.rcon_password, command)))
      .then((response) => {
        if (response !== undefined) send({ type: "response", response });
      })
      .catch((err) => send({ type: "error", message: err instanceof Error ? err.message : "RCON command failed." }));
  });
}
