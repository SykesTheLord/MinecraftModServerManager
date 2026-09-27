import { PassThrough } from "node:stream";
import { docker } from "./dockerClient.js";

export interface LogSubscription {
  stop(): void;
}

export interface FollowOptions {
  /** Only deliver lines strictly newer than this (a timestamp previously passed to onLine). */
  after?: string;
  /** How many historical lines to replay on the first connection when `after` isn't given. Default: all. */
  tail?: number;
}

const RECONNECT_DELAY_MS = 5_000;

/**
 * Docker timestamps are RFC3339Nano with trailing fractional zeros trimmed,
 * so they don't compare correctly as strings. Normalizes to a fixed 9-digit
 * fraction so lexicographic order == chronological order. Also accepts the
 * millisecond ISO strings older console.log files were written with.
 */
export function normalizeTimestamp(ts: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (!m) return null;
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}Z`;
}

/** Normalized timestamp -> "seconds.nanoseconds", the format Docker's `since` accepts. */
function toDockerSince(normalizedTs: string): string {
  const seconds = Math.floor(Date.parse(normalizedTs.slice(0, 19) + "Z") / 1000);
  return `${seconds}.${normalizedTs.slice(20, 29)}`;
}

function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 404;
}

/**
 * Follows a container's combined stdout/stderr and invokes `onLine` for each
 * line, with the Docker-recorded timestamp of that line (normalized, see
 * normalizeTimestamp).
 *
 * Docker ends a follow stream whenever the container stops — including when
 * its own `unless-stopped` policy relaunches a crashed container — so a single
 * `container.logs({follow})` call silently goes quiet after the first crash.
 * This keeps following across restarts: when the stream ends it waits for the
 * container to be running again and resumes from the last timestamp it
 * delivered, so nothing is replayed twice. It only gives up when stopped or
 * when the container no longer exists.
 *
 * itzg/docker-minecraft-server containers run without a TTY, so Docker
 * multiplexes stdout/stderr into one stream and we demux it via dockerode's
 * helper before it's readable text.
 */
export function followContainerLogs(
  containerId: string,
  onLine: (line: string, timestamp: string) => void,
  options: FollowOptions = {}
): LogSubscription {
  const container = docker.getContainer(containerId);
  let stopped = false;
  let last = options.after ?? null;
  let first = true;
  let current: { destroy(): void } | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const deliver = (raw: string) => {
    const space = raw.indexOf(" ");
    const ts = space > 0 ? normalizeTimestamp(raw.slice(0, space)) : null;
    if (!ts) return;
    if (last && ts <= last) return; // `since` has only second-level guarantees; drop overlap
    last = ts;
    onLine(raw.slice(space + 1), ts);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    retryTimer = setTimeout(() => void connect(), RECONNECT_DELAY_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      const info = await container.inspect();
      if (!info.State.Running && !first) {
        scheduleReconnect(); // wait for Docker (or a user) to start it again
        return;
      }

      const opts: Record<string, unknown> = { follow: true, stdout: true, stderr: true, timestamps: true };
      if (last) opts.since = toDockerSince(last);
      else if (first && options.tail !== undefined) opts.tail = options.tail;
      first = false;

      const logStream = (await container.logs(opts as { follow: true })) as NodeJS.ReadableStream & {
        destroy(): void;
      };
      if (stopped) {
        logStream.destroy();
        return;
      }

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(logStream, stdout, stderr);

      const makeLineHandler = () => {
        let buffer = "";
        const handler = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) deliver(line);
        };
        return { handler, flush: () => buffer && deliver(buffer) };
      };
      const out = makeLineHandler();
      const err = makeLineHandler();
      stdout.on("data", out.handler);
      stderr.on("data", err.handler);

      let ended = false;
      const onEnd = () => {
        if (ended) return;
        ended = true;
        out.flush();
        err.flush();
        stdout.destroy();
        stderr.destroy();
        current = null;
        scheduleReconnect();
      };
      logStream.on("end", onEnd);
      logStream.on("close", onEnd);
      logStream.on("error", onEnd);

      current = {
        destroy() {
          ended = true;
          logStream.destroy();
          stdout.destroy();
          stderr.destroy();
        },
      };
    } catch (err) {
      if (isNotFound(err)) {
        stopped = true; // container is gone — nothing more to follow
        return;
      }
      scheduleReconnect();
    }
  };

  void connect();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.destroy();
      current = null;
    },
  };
}

export async function getRecentLogs(containerId: string, tailLines = 200): Promise<string> {
  const container = docker.getContainer(containerId);
  const buffer = (await container.logs({
    follow: false,
    stdout: true,
    stderr: true,
    tail: tailLines,
  })) as unknown as Buffer;

  // Non-follow logs come back as a single buffer with the same 8-byte frame
  // headers per chunk; strip them rather than pulling in the stream demuxer.
  let text = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    text += buffer.subarray(start, end).toString("utf8");
    offset = end;
  }
  return text || buffer.toString("utf8");
}
