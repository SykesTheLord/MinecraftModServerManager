import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Docker from "dockerode";
import { env } from "../config/env.js";
import { docker } from "../docker/dockerClient.js";
import { readContainerFile } from "../docker/containerFiles.js";
import { ensureImagePulled } from "../docker/images.js";
import { HARDENED_HOST_CONFIG } from "../docker/containerSpec.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { HttpError } from "../http/errors.js";
import { appLogger } from "../logging/appLogger.js";
import { startPersistingInstanceLogs, stopPersistingInstanceLogs } from "../logging/instanceLogWriter.js";
import { packForContainer } from "../imports/archive.js";
import { buildImportedServerEnv } from "../imports/serverEnv.js";
import type { ServerType } from "../imports/analyze.js";
import { getCfFiles, getCfModpack, getCfMods } from "./cfClient.js";

/**
 * Installs a CurseForge modpack into an instance's volume WITHOUT the
 * CurseForge API key ever reaching the modpack.
 *
 * itzg's own TYPE=AUTO_CURSEFORGE needs the key inside the server container
 * permanently (it re-syncs the pack on every start), where any of the pack's
 * hundreds of third-party mods could read it. Instead, a short-lived install
 * container runs just the installer that image ships (`mc-image-helper
 * install-curseforge`: downloads the pack + mods, installs the mod loader —
 * no pack code runs), writing into the volume. The installer leaves a
 * `.curseforge-manifest.json` with the pack's `minecraftVersion` and
 * `modLoaderId` (e.g. "forge-47.2.0"; field names read from mc-image-helper's
 * own classes), from which the real server container is configured exactly
 * like an imported server: TYPE=FORGE/NEOFORGE/FABRIC/QUILT + versions, no key.
 *
 * Some mod authors disallow automated downloads. The installer then fails and
 * writes MODS_NEED_DOWNLOAD.txt (a human-readable table whose last column is
 * each file's CurseForge page, …/mc-mods/<slug>/download/<fileId> — seen in a
 * real run; the mod-name column can be truncated). Those file ids are looked up
 * in the API, the instance goes to `awaiting_files`, and the admin uploads
 * the jars (verified against CurseForge's SHA-1, or MD5 if that's all it
 * lists; unverifiable files are refused) into a downloads repo the
 * installer is pointed at on the next attempt.
 *
 * The database keeps only the id and file name of each file an install
 * waits for — names, links and checksums are looked up when they're shown or
 * an upload is checked (through cfClient's cache). mc-image-helper keeps its
 * own API cache in the volume (/data/.cache/curseforge, days by default) so
 * retries don't re-query everything; CurseForge's API terms forbid caching,
 * and this is a deliberate choice to stay under its request limits.
 */

/** What's stored per file an install is waiting for: its id, and the file name the installer looks for. */
export interface MissingFile {
  fileId: number;
  fileName: string;
}

/** A missing file as shown to the admin, looked up live (not stored). */
export interface MissingFileDetail extends MissingFile {
  modName: string;
  displayName: string;
  pageUrl: string;
}

const INSTALL_CONTAINER_PREFIX = "mc-install-";
/** Inside the volume; mc-image-helper also consults its mods/ subdirectory. */
const DOWNLOADS_REPO = ".manual-downloads";
const MAX_MANUAL_FILE_BYTES = 512 * 1024 * 1024;
const INSTALL_MEMORY_BYTES = 2 * 1024 ** 3; // the Forge installer is the heavy part

const running = new Set<string>();

const stagingDir = (instanceId: string) => path.join(env.DATA_DIR, "curseforge-downloads", instanceId);
const installContainerName = (instanceId: string) => `${INSTALL_CONTAINER_PREFIX}${instanceId}`;

export function isInstallRunning(instanceId: string): boolean {
  return running.has(instanceId);
}

export function parseMissingFiles(row: Pick<InstanceRow, "missing_files">): MissingFile[] {
  if (!row.missing_files) return [];
  return (JSON.parse(row.missing_files) as MissingFile[]).map(({ fileId, fileName }) => ({ fileId, fileName }));
}

/** Which of an instance's missing files have already been uploaded. */
export function uploadedFileNames(instanceId: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(stagingDir(instanceId), "mods")));
  } catch {
    return new Set();
  }
}

function loaderToServerType(modLoaderId: string): { serverType: ServerType; loaderVersion: string } | null {
  const match = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(modLoaderId);
  if (!match) return null;
  return { serverType: match[1].toUpperCase() as ServerType, loaderVersion: match[2] };
}

async function identifyMissingFiles(table: string): Promise<MissingFile[]> {
  const fileIds = [...new Set([...table.matchAll(/\/(?:download|files)\/(\d+)/g)].map((m) => Number(m[1])))];
  if (fileIds.length === 0) throw new Error("The installer reported files needing a manual download, but none could be identified. See the install log.");
  return (await getCfFiles(fileIds)).map((f) => ({ fileId: f.id, fileName: f.fileName }));
}

/** Names and download pages for the files an install is waiting for, fetched live from CurseForge. */
export async function describeMissingFiles(instance: InstanceRow): Promise<MissingFileDetail[]> {
  const waiting = parseMissingFiles(instance);
  if (waiting.length === 0) return [];
  const files = new Map((await getCfFiles(waiting.map((f) => f.fileId))).map((f) => [f.id, f]));
  const mods = new Map((await getCfMods([...new Set([...files.values()].map((f) => f.modId))])).map((m) => [m.id, m]));
  return waiting.map(({ fileId, fileName }) => {
    const file = files.get(fileId);
    const mod = file ? mods.get(file.modId) : undefined;
    return {
      fileId,
      fileName,
      modName: mod?.name ?? file?.displayName ?? fileName,
      displayName: file?.displayName ?? fileName,
      pageUrl: `${mod?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${file?.modId ?? ""}`}/files/${fileId}`,
    };
  });
}

async function removeInstallContainer(instanceId: string): Promise<void> {
  const container = docker.getContainer(installContainerName(instanceId));
  await container.remove({ force: true }).catch(() => undefined);
}

/** Copies the admin's manually downloaded files into the volume's downloads repo, via the (not yet started) install container. */
async function copyManualDownloads(instanceId: string, container: Docker.Container): Promise<void> {
  const dir = stagingDir(instanceId);
  if (!fs.existsSync(path.join(dir, "mods"))) return;
  await container.putArchive(packForContainer(dir, DOWNLOADS_REPO), { path: "/data" });
}

/**
 * Runs the install container to completion and returns what happened. The
 * container gets the API key in its environment; it only ever runs
 * mc-image-helper (and the mod loader's official installer), never pack code,
 * and is removed straight afterwards.
 */
async function runInstallContainer(
  instance: InstanceRow,
  slug: string
): Promise<{ manifest: { minecraftVersion?: string; modLoaderId?: string; levelName?: string } | null; missingTable: string | null; exitCode: number }> {
  await removeInstallContainer(instance.id);
  const container = await docker.createContainer({
    name: installContainerName(instance.id),
    Image: instance.image,
    // Bypass itzg's entrypoint (which would go on to start the server) and run the installer alone, as the image's
    // minecraft user. A missing-files list left by an earlier attempt must not be mistaken for this one's.
    Entrypoint: ["sh", "-c", 'rm -f /data/MODS_NEED_DOWNLOAD.txt && exec mc-image-helper "$@"', "install"],
    Cmd: [
      "install-curseforge",
      `--slug=${slug}`,
      `--file-id=${instance.cf_file_id}`,
      "--output-directory=/data",
      "--results-file=/data/.install-curseforge.env",
      `--downloads-repo=/data/${DOWNLOADS_REPO}`,
      // Same client-only-mod exclusions itzg applies itself (they crash dedicated servers).
      "--exclude-include-file=/image/cf-exclude-include.json",
      `--api-base-url=${env.CF_API_BASE_URL}`,
    ],
    Env: [`CF_API_KEY=${env.CF_API_KEY}`],
    User: "1000:1000",
    WorkingDir: "/data",
    Labels: { "mcmgr.managed": "true", "mcmgr.instanceId": instance.id, "mcmgr.role": "installer" },
    HostConfig: {
      ...HARDENED_HOST_CONFIG,
      Binds: [`${instance.volume_name}:/data`],
      Memory: INSTALL_MEMORY_BYTES,
      MemorySwap: INSTALL_MEMORY_BYTES,
      // Default bridge, not mc-net: it needs the internet, not other servers.
    },
  });

  try {
    await copyManualDownloads(instance.id, container);
    await container.start();
    startPersistingInstanceLogs(instance.id, container.id);
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    await new Promise((resolve) => setTimeout(resolve, 1000)); // let the last log lines land
    stopPersistingInstanceLogs(instance.id);

    const manifestText = await readContainerFile(container, "/data/.curseforge-manifest.json");
    const missingTable = await readContainerFile(container, "/data/MODS_NEED_DOWNLOAD.txt");
    return { manifest: manifestText ? JSON.parse(manifestText) : null, missingTable, exitCode: StatusCode };
  } finally {
    stopPersistingInstanceLogs(instance.id);
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/**
 * Installs (or resumes installing) a CurseForge instance, then hands it to
 * `startServer` once its files are in place. Runs in the background; every
 * outcome ends up in the instance's status/last_error.
 */
export async function installCurseForgeInstance(
  instanceId: string,
  startServer: (instance: InstanceRow) => Promise<void>
): Promise<void> {
  if (running.has(instanceId)) throw new HttpError(409, "An install is already running for this instance.");
  running.add(instanceId);
  instanceRepo.updateStatus(instanceId, "creating");
  try {
    let instance = instanceRepo.findById(instanceId)!;
    const pack = await getCfModpack(instance.cf_mod_id!);
    await ensureImagePulled(instance.image);
    await docker.createVolume({
      Name: instance.volume_name,
      // Lets scripts/cleanup.sh find every server's volume (older ones only match by name).
      Labels: { "mcmgr.managed": "true", "mcmgr.instanceId": instance.id },
    });

    const result = await runInstallContainer(instance, pack.slug);
    if (!instanceRepo.findById(instanceId)) return; // deleted meanwhile

    if (result.missingTable && result.exitCode !== 0) {
      const missing = await identifyMissingFiles(result.missingTable);
      instanceRepo.setMissingFiles(instanceId, missing);
      instanceRepo.updateStatus(
        instanceId,
        "awaiting_files",
        `${missing.length} file(s) can't be downloaded automatically — their authors only allow downloads from CurseForge's site.`
      );
      appLogger.warn({ instanceId, count: missing.length }, "curseforge install needs manual downloads");
      return;
    }

    const loader = result.manifest?.modLoaderId ? loaderToServerType(result.manifest.modLoaderId) : null;
    if (result.exitCode !== 0 || !result.manifest?.minecraftVersion || !loader) {
      throw new Error(
        result.exitCode !== 0
          ? `The CurseForge installer failed (exit ${result.exitCode}). See the install log below.`
          : `Installed, but couldn't tell which mod loader the pack uses (${result.manifest?.modLoaderId ?? "none"}).`
      );
    }

    const serverEnv = buildImportedServerEnv(
      {
        serverType: loader.serverType,
        minecraftVersion: result.manifest.minecraftVersion,
        loaderVersion: loader.loaderVersion,
        // A pack's own level name, else the world folder the server already had (an imported server
        // converted to its CurseForge pack), else Minecraft's default.
        levelName:
          result.manifest.levelName ||
          (JSON.parse(instance.server_env ?? "{}") as Record<string, string>).LEVEL ||
          "world",
      },
      []
    );
    // The image (Java) was picked at creation from the file's Minecraft version, or chosen by the admin; keep it.
    instanceRepo.setResolvedServer(instanceId, { serverEnv, image: instance.image, packName: instance.ftb_pack_name });
    instanceRepo.setMissingFiles(instanceId, null);
    fs.rmSync(stagingDir(instanceId), { recursive: true, force: true });

    instance = instanceRepo.findById(instanceId)!;
    await startServer(instance);
  } catch (err) {
    appLogger.error({ err, instanceId }, "curseforge install failed");
    if (instanceRepo.findById(instanceId)) {
      instanceRepo.updateStatus(instanceId, "error", err instanceof Error ? err.message : String(err));
    }
  } finally {
    running.delete(instanceId);
  }
}

/**
 * Stores one manually downloaded file for a blocked install, after checking
 * it's exactly the file CurseForge lists (name and SHA-1, or MD5 when that's
 * all CurseForge has; looked up live) — so a wrong or tampered jar can't slip
 * into the server. A file with no published hash can't be verified, so it's
 * refused.
 */
export async function storeManualDownload(instance: InstanceRow, fileId: number, body: Readable): Promise<void> {
  const wanted = parseMissingFiles(instance).find((f) => f.fileId === fileId);
  if (!wanted) throw new HttpError(404, "That file isn't one this install is waiting for.");
  const live = (await getCfFiles([fileId]))[0];
  if (!live || live.fileName !== wanted.fileName) {
    throw new HttpError(409, `CurseForge no longer lists ${wanted.fileName} as it was. Retry the install to refresh the list of files.`);
  }
  const expected = live.sha1 ? { algo: "sha1", value: live.sha1 } : live.md5 ? { algo: "md5", value: live.md5 } : null;
  if (!expected) {
    throw new HttpError(409, `CurseForge lists no checksum for ${wanted.fileName}, so an upload can't be verified.`);
  }

  const dir = path.join(stagingDir(instance.id), "mods");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(wanted.fileName));
  const partial = `${target}.part`;
  const hash = crypto.createHash(expected.algo);
  let size = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_MANUAL_FILE_BYTES) return callback(new HttpError(413, "File is too large."));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, verify, fs.createWriteStream(partial));
    if (hash.digest("hex") !== expected.value) {
      throw new HttpError(400, `That isn't ${wanted.fileName} (its checksum doesn't match CurseForge's). Download the exact file from the link.`);
    }
    fs.renameSync(partial, target);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/** Removes everything an instance's install left outside its volume. */
export async function cleanupCurseForgeInstall(instanceId: string): Promise<void> {
  await removeInstallContainer(instanceId);
  fs.rmSync(stagingDir(instanceId), { recursive: true, force: true });
}

/** Helper containers (CurseForge installs, pre-update backups) that outlived a manager restart have nobody waiting on them. */
export async function removeOrphanedHelperContainers(): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["mcmgr.role"] }) });
  for (const info of containers) {
    await docker.getContainer(info.Id).remove({ force: true }).catch(() => undefined);
  }
}

