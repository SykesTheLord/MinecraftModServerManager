import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import tarFs from "tar-fs";
import yauzl from "yauzl";
import { HttpError } from "../http/errors.js";

/**
 * itzg/minecraft-server runs the server as its built-in `minecraft` user
 * (uid/gid 1000). Its entrypoint only re-chowns /data when /data *itself* is
 * owned by someone else — a fresh volume's /data already is 1000 — so files
 * copied in must carry that owner themselves or the server can't write to
 * its own world.
 */
const MINECRAFT_UID = 1000;

/**
 * Resolves an archive entry name inside `dest`, or null if it would land
 * outside it (absolute paths, drive letters, `..` segments). Archives come
 * from another machine, so every entry name is checked, on top of whatever
 * the extraction library does itself.
 */
export function safeJoin(dest: string, name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const target = path.resolve(dest, normalized);
  return target === dest || target.startsWith(dest + path.sep) ? target : null;
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, `The server files are larger than the import limit (${Math.round(maxBytes / 1024 ** 3)} GiB, IMPORT_MAX_BYTES).`);
}

/**
 * Extracts a (optionally gzipped) tar stream into `dest`. Only regular files
 * and directories are written: symlinks and hardlinks are dropped, since a
 * link followed by a file "inside" it is the classic way for an archive to
 * write outside its destination, and a Minecraft server doesn't need them.
 * Entries past `maxBytes` of total content are skipped and reported as an
 * error afterwards, so a runaway archive can't fill the disk.
 */
export async function extractTarStream(source: Readable, dest: string, gzip: boolean, maxBytes: number): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  let total = 0;
  let exceeded = false;
  const extract = tarFs.extract(dest, {
    ignore: (_name, header) => {
      if (!header || (header.type !== "file" && header.type !== "directory")) return true;
      if (safeJoin(dest, header.name) === null) return true;
      total += header.size ?? 0;
      if (total > maxBytes) exceeded = true;
      return exceeded;
    },
    readable: true,
    writable: true,
  });
  if (gzip) {
    await pipeline(source, zlib.createGunzip(), extract);
  } else {
    await pipeline(source, extract);
  }
  if (exceeded) throw tooLarge(maxBytes);
}

function extractZip(file: string, dest: string, maxBytes: number): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  let total = 0;
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr) return reject(openErr);
      zip.on("error", reject);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const target = safeJoin(dest, entry.fileName);
        const isSymlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
        if (!target || isSymlink) return zip.readEntry();
        if (entry.fileName.endsWith("/")) {
          fs.mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        total += entry.uncompressedSize;
        if (total > maxBytes) {
          zip.close();
          return reject(tooLarge(maxBytes));
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          pipeline(stream, fs.createWriteStream(target)).then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
  });
}

/** Extracts an uploaded .zip, .tar or .tar.gz (detected by content, not name) into `dest`. */
export async function extractArchiveFile(file: string, dest: string, maxBytes: number): Promise<void> {
  const magic = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (magic.readUInt32BE(0) === 0x504b0304) {
    await extractZip(file, dest, maxBytes);
  } else if (magic[0] === 0x1f && magic[1] === 0x8b) {
    await extractTarStream(fs.createReadStream(file), dest, true, maxBytes);
  } else {
    await extractTarStream(fs.createReadStream(file), dest, false, maxBytes);
  }
}

/** A tar of `root`'s contents, owned by the container's minecraft user, for Docker's putArchive. */
export function packForContainer(root: string): Readable {
  return tarFs.pack(root, {
    map: (header) => ({ ...header, uid: MINECRAFT_UID, gid: MINECRAFT_UID, uname: "minecraft", gname: "minecraft" }),
  });
}
