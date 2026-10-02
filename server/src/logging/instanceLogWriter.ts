import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { followContainerLogs, normalizeTimestamp, type LogSubscription } from "../docker/logsStream.js";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // trim once a single instance log passes 10MB

const activeWriters = new Map<string, LogSubscription>();

function instanceLogPath(instanceId: string): string {
  const dir = path.join(env.LOGS_DIR, "instances", instanceId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "console.log");
}

function appendLine(filePath: string, line: string): void {
  fs.appendFileSync(filePath, line + "\n", "utf8");
  const { size } = fs.statSync(filePath);
  if (size > MAX_LOG_BYTES) {
    const content = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, content.slice(Math.floor(content.length / 2)), "utf8");
  }
}

/**
 * Timestamp of the newest line already persisted, so re-subscribing (after a
 * manager restart or an instance start) resumes where the file left off
 * instead of replaying the container's recent history into it again.
 */
function lastPersistedTimestamp(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      const ts = normalizeTimestamp(line.slice(0, line.indexOf(" ")));
      if (ts) return ts;
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Starts (or restarts) persisting an instance's console output to logs/instances/<id>/console.log. */
export function startPersistingInstanceLogs(instanceId: string, containerId: string): void {
  stopPersistingInstanceLogs(instanceId);
  const filePath = instanceLogPath(instanceId);

  const subscription = followContainerLogs(
    containerId,
    (line, timestamp) => appendLine(filePath, `${timestamp} ${line}`),
    { after: lastPersistedTimestamp(filePath) }
  );
  activeWriters.set(instanceId, subscription);
}

export function stopPersistingInstanceLogs(instanceId: string): void {
  activeWriters.get(instanceId)?.stop();
  activeWriters.delete(instanceId);
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The last lines of an instance's persisted console log (without timestamps or terminal colors) — e.g. a CurseForge install's output. */
export function readPersistedLogTail(instanceId: string, lines = 200): string {
  const filePath = path.join(env.LOGS_DIR, "instances", instanceId, "console.log");
  if (!fs.existsSync(filePath)) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-lines)
      .map((line) => (normalizeTimestamp(line.slice(0, line.indexOf(" "))) ? line.slice(line.indexOf(" ") + 1) : line))
      .map((line) => line.replace(ANSI_ESCAPE, ""))
      .join("\n");
  } finally {
    fs.closeSync(fd);
  }
}
