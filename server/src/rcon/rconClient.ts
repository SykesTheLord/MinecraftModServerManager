import { Rcon } from "rcon-client";

/**
 * Sends a single console command to a running instance over RCON and returns
 * its response. Opens a short-lived connection per call rather than pooling —
 * simplest option, and console commands here are low-frequency/interactive.
 */
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
