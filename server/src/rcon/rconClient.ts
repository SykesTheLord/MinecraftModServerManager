import { Rcon } from "rcon-client";

/**
 * Sends a single console command to a running instance over RCON and returns
 * its response. Opens a short-lived connection per call rather than pooling —
 * simplest option, and console commands here are low-frequency/interactive.
 */
/**
 * A console-friendly explanation of a failed RCON call. Minecraft only opens
 * RCON once the server has finished loading, so "connection refused" while it
 * boots is expected — it isn't an error with the command. `serverStatus` is
 * the instance's status, to tell "still starting" from "not running".
 */
export function describeRconError(err: unknown, serverStatus: string): string {
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ECONNREFUSED") {
    if (serverStatus === "installing") {
      return "The server is still starting — it accepts commands once it has finished loading (look for the \"Done\" line in the log).";
    }
    if (serverStatus === "stopping") return "The server is stopping, so it no longer accepts commands.";
    return "The server isn't accepting commands — it may have stopped or crashed (check the log above).";
  }
  if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "EAI_AGAIN") return "The server isn't running.";
  if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "The server didn't answer in time — it may be busy or frozen. Try again.";
  if (/authentication failed/i.test(message)) {
    return "The server rejected the console's RCON password. Restart it: the manager sets the password on every start.";
  }
  return `The command couldn't be sent: ${message}`;
}

export async function sendConsoleCommand(
  host: string,
  password: string,
  command: string,
  port: number = 25575
): Promise<string> {
  const rcon = await Rcon.connect({ host, port, password });
  try {
    return await rcon.send(command);
  } finally {
    await rcon.end();
  }
}
