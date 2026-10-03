import type { Duplex } from "node:stream";
import { docker } from "./dockerClient.js";
import { HttpError } from "../http/errors.js";

/**
 * Typing into a server's own console (its stdin), for when RCON can't help:
 * Minecraft only opens RCON once it has finished starting, but a server can
 * stop partway to ask a question there — e.g. Forge's "missing registry
 * entries" prompt, answered with `/fml confirm` or `/fml cancel`. itzg's
 * runner forwards its stdin to the server; the container needs OpenStdin
 * (set by containerSpec, and added to older containers when they're next
 * started — see instanceService.startInstance).
 */
const MAX_LINE = 1000;

/**
 * Whether the container has a stdin to type into that stays open between
 * writes. StdinOnce must be off: with it on (as `docker run -i` sets it),
 * Docker closes the container's stdin when the first writer disconnects, and
 * everything typed after that is lost.
 */
export async function hasConsoleInput(containerId: string): Promise<boolean> {
  const { Config } = await docker.getContainer(containerId).inspect();
  return Boolean(Config.OpenStdin) && !Config.StdinOnce;
}

export async function writeConsoleLine(containerId: string, line: string): Promise<void> {
  const text = line.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_LINE);
  if (!text) return;
  if (!(await hasConsoleInput(containerId))) {
    throw new HttpError(409, "This server's container predates console input. Stop and start the server once to enable it.");
  }
  const stream = (await docker.getContainer(containerId).attach({
    stream: true,
    stdin: true,
    stdout: false,
    stderr: false,
    hijack: true,
  })) as unknown as Duplex;
  // Closing our side only ends this attach: the container keeps its stdin (StdinOnce is off).
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(`${text}\n`, () => resolve());
  });
}
