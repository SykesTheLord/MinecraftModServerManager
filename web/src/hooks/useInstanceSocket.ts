import { useCallback, useEffect, useRef, useState } from "react";

type ServerMessage =
  | { type: "log"; line: string }
  | { type: "response"; response: string }
  | { type: "error"; message: string };

/**
 * "ended" = the server closed normally because there's no container to follow;
 * "denied" = the session ended or access was revoked while it was open.
 */
export type SocketStatus = "connecting" | "open" | "reconnecting" | "ended" | "denied";

const RECONNECT_DELAY_MS = 3000;

export function useInstanceSocket(instanceId: string) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (line: string) => setLines((prev) => [...prev.slice(-999), line]);

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws/instances/${instanceId}/console`);
      wsRef.current = ws;

      ws.onopen = () => setStatus("open");

      ws.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "log") append(message.line);
        else if (message.type === "response") append(`> ${message.response}`);
        else if (message.type === "error") append(`[error] ${message.message}`);
      };

      // The server follows the container across its own restarts and closes
      // with 1000 only when there's nothing to follow; anything else (e.g. the
      // manager restarting) is a dropped connection worth retrying. The
      // server re-sends recent history on connect, so start from a clean slate.
      ws.onclose = (event) => {
        if (disposed) return;
        if (event.code === 1000) {
          setStatus("ended");
          return;
        }
        // 4401/4403 (see server/src/ws/consoleGateway.ts): retrying can't succeed.
        if (event.code >= 4000 && event.code < 5000) {
          setStatus("denied");
          return;
        }
        setStatus("reconnecting");
        reconnectTimer = setTimeout(() => {
          setLines([]);
          connect();
        }, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [instanceId]);

  /** Whether the command was actually sent (the socket may be between reconnects). */
  const sendCommand = useCallback((command: string): boolean => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "command", command }));
    return true;
  }, []);

  return { lines, status, sendCommand };
}
