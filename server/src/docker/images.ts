import { docker } from "./dockerClient.js";
import { appLogger } from "../logging/appLogger.js";

/**
 * Unlike `docker run`, the Engine API's createContainer call does not pull a
 * missing image on its own — confirmed by actually hitting a "no such image"
 * error when creating the first instance. Pulls only if the image (and tag)
 * aren't already present locally, so repeat instance creation doesn't re-pull.
 */
export async function ensureImagePulled(image: string): Promise<void> {
  const existing = await docker.listImages({ filters: JSON.stringify({ reference: [image] }) });
  if (existing.length > 0) return;

  appLogger.info({ image }, "pulling docker image");
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
  appLogger.info({ image }, "docker image pulled");
}
