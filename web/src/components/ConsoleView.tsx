import { useEffect, useRef, useState } from "react";
import { useInstanceSocket } from "../hooks/useInstanceSocket";

export function ConsoleView({ instanceId }: { instanceId: string }) {
  const { lines, sendCommand } = useInstanceSocket(instanceId);
  const [command, setCommand] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  return (
    <div className="console-view">
      <div className="console-log" ref={scrollRef}>
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
          if (!command.trim()) return;
          sendCommand(command.trim());
          setCommand("");
        }}
      >
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Type a server command (e.g. list)"
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
