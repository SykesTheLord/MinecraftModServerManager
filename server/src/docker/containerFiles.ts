import type { Readable } from "node:stream";
import type Docker from "dockerode";
import tarStream from "tar-stream";

/** The minecraft user inside itzg images (see imports/archive.ts). */
const MINECRAFT_UID = 1000;

/**
 * Reads one small file out of a container's filesystem (running or stopped;
 * volume paths included) via Docker's archive API. Null if it isn't there.
 */
export async function readContainerFile(
  container: Docker.Container,
  filePath: string,
  maxBytes = 1024 * 1024
): Promise<string | null> {
  let archive: Readable;
  try {
    archive = (await container.getArchive({ path: filePath })) as unknown as Readable;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
  return new Promise((resolve, reject) => {
    const extract = tarStream.extract();
    let content: string | null = null;
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (data) => {
        const chunk = data as Buffer;
        size += chunk.length;
        if (content === null && header.type === "file" && size <= maxBytes) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (content === null && header.type === "file" && size <= maxBytes) content = Buffer.concat(chunks).toString("utf8");
        next();
      });
      stream.resume();
    });
    extract.on("finish", () => resolve(content));
    extract.on("error", reject);
    archive.pipe(extract);
  });
}

/** Writes one file into a container's filesystem (e.g. its /data volume), owned by the minecraft user. */
export async function writeContainerFile(container: Docker.Container, dir: string, name: string, content: string): Promise<void> {
  const pack = tarStream.pack();
  pack.entry({ name, mode: 0o644, uid: MINECRAFT_UID, gid: MINECRAFT_UID, mtime: new Date() }, content);
  pack.finalize();
  await container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: dir });
}
