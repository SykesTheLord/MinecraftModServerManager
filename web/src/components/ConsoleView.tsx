import { useEffect, useRef, useState } from "react";
import { useInstanceSocket, type SocketStatus } from "../hooks/useInstanceSocket";

const STATUS_LABELS: Record<SocketStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Disconnected — reconnecting…",
  ended: "Not running",
  denied: "Disconnected — your session ended or your access changed. Reload the page.",
};

/** How close to the bottom (px) still counts as "following" the log. */
const FOLLOW_SLACK_PX = 40;
const HISTORY_LIMIT = 50;

export function ConsoleView({ instanceId }: { instanceId: string }) {
  const { lines, status, sendCommand } = useInstanceSocket(instanceId);
  const [command, setCommand] = useState("");
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sent commands, newest last; `cursor` is where ↑/↓ currently is in it (history.length = the draft).
  const history = useRef<string[]>([]);
  const [cursor, setCursor] = useState(0);

  // Only pin to the bottom while the user hasn't scrolled up to read something.
  useEffect(() => {
    if (following) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, following]);

  const jumpToLatest = () => {
    setFollowing(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  };

  const canSend = status === "open";

  return (
    <div className="console-view">
      <div className="console-status">
        <span className={`console-dot ${status}`} aria-hidden="true" />
        <span>{STATUS_LABELS[status]}</span>
        {!following && (
          <button type="button" className="ghost small" onClick={jumpToLatest}>
            ↓ Jump to latest
          </button>
        )}
      </div>
      <div
        className="console-log"
        ref={scrollRef}
        role="log"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX);
        }}
      >
        {lines.length === 0 && <div className="console-line muted">{status === "open" ? "Waiting for output…" : ""}</div>}
        {lines.map((line, i) => (
          <div key={i} className="console-line">
            {line}
          </div>
        ))}
      </div>
      <form
        className="console-input"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = command.trim();
          if (!trimmed || !sendCommand(trimmed)) return;
          history.current = [...history.current.filter((c) => c !== trimmed), trimmed].slice(-HISTORY_LIMIT);
          setCursor(history.current.length);
          setCommand("");
          jumpToLatest();
        }}
      >
        <span className="console-prompt" aria-hidden="true">
          &gt;
        </span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const h = history.current;
            const next = Math.max(0, Math.min(h.length, cursor + (e.key === "ArrowUp" ? -1 : 1)));
            if (next === cursor) return;
            e.preventDefault();
            setCursor(next);
            setCommand(h[next] ?? "");
          }}
          placeholder={canSend ? "Server command, e.g. list (↑ for history)" : "Console unavailable"}
          aria-label="Server command"
          autoComplete="off"
          spellCheck={false}
          disabled={!canSend}
        />
        <button type="submit" disabled={!canSend || !command.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
