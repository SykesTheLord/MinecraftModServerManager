import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { RequestHandler, Request, Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { userRepo } from "../db/repositories/userRepo.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { hasInstanceRole } from "../auth/userService.js";
import { followContainerLogs } from "../docker/logsStream.js";
import { sendConsoleCommand } from "../rcon/rconClient.js";
import { isCrossOriginBrowserRequest, isFromInstanceNetwork } from "../http/security.js";

const ROUTE_PATTERN = /^\/ws\/instances\/([^/]+)\/console$/;

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

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, instanceId);
      });
    });
  });
}

function handleConnection(ws: WebSocket, instanceId: string): void {
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
  ws.on("close", () => logSubscription.stop());

  ws.on("message", (raw) => {
    let payload: { type?: string; command?: string };
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (payload.type !== "command" || !payload.command) return;

    sendConsoleCommand(instance.container_name, instance.rcon_password, payload.command)
      .then((response) => send({ type: "response", response }))
      .catch((err) => send({ type: "error", message: err instanceof Error ? err.message : "RCON command failed." }));
  });
}
