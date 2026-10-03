import { docker } from "../docker/dockerClient.js";
import { HARDENED_HOST_CONFIG } from "../docker/containerSpec.js";
import { getRecentLogs } from "../docker/logsStream.js";
import type { InstanceRow } from "../db/repositories/instanceRepo.js";
import { HttpError } from "../http/errors.js";
import { sendConsoleCommand } from "../rcon/rconClient.js";

/**
 * World backups inside an instance's own volume (`/data/.update-backups/`):
 * taken automatically before every modpack update and before every restore,
 * or on demand. Each archive holds everything except what the server can
 * re-download or regenerate (mods, libraries, logs, caches) — so the world,
 * configs, server.properties and player data — and has a `.json` sidecar
 * saying what it is and which pack version it was taken on.
 *
 * All file work happens in throwaway containers (label mcmgr.role=backup,
 * no network, the image's minecraft user) that mount the volume; nothing
 * is copied out to the manager.
 */

export const BACKUP_DIR = "/data/.update-backups";
export const BACKUPS_KEPT = 5;
// Re-downloadable or regenerated on boot; the world, configs and player data are what matter.
const BACKUP_EXCLUDES = [
  "./.update-backups",
  "./mods",
  "./mods.before-pack-*",
  "./libraries",
  "./versions",
  "./logs",
  "./crash-reports",
  "./.cache",
  "./.manual-downloads",
];
/** Top-level paths a restore never deletes (the backup doesn't contain them, and the installed pack owns them). */
const NEVER_RESTORED = [".update-backups", "mods", "mods.before-pack-*", "libraries", "versions", ".manual-downloads"];
const NAME = /^[0-9TZ-]+-[A-Za-z0-9._-]+\.tar\.gz$/;

export type BackupReason = "update" | "manual" | "restore";

export interface BackupMeta {
  reason: BackupReason;
  /** Pack version (FTB version id / CurseForge file id) the server was on, if any. */
  versionId: number | null;
  versionName: string | null;
  createdAt: string;
}

export interface BackupInfo extends Partial<BackupMeta> {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

/** Runs a shell script in a throwaway container with the instance's volume at /data. */
async function runInVolume(instance: InstanceRow, script: string): Promise<string> {
  const containerName = `mc-backup-${instance.id}`;
  await docker.getContainer(containerName).remove({ force: true }).catch(() => undefined);
  const container = await docker.createContainer({
    name: containerName,
    Image: instance.image,
    Entrypoint: ["sh", "-c", script],
    User: "1000:1000",
    Labels: { "mcmgr.managed": "true", "mcmgr.instanceId": instance.id, "mcmgr.role": "backup" },
    HostConfig: { ...HARDENED_HOST_CONFIG, Binds: [`${instance.volume_name}:/data`], NetworkMode: "none" },
  });
  try {
    await container.start();
    const { StatusCode } = (await container.wait()) as { StatusCode: number };
    const output = (await getRecentLogs(container.id, 500).catch(() => "")).trim();
    if (StatusCode !== 0) throw new Error(`exit ${StatusCode}${output ? `: ${output.split("\n").slice(-5).join(" / ")}` : ""}`);
    return output;
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}

/** POSIX single-quoting for values embedded in the helper scripts. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function currentVersion(instance: InstanceRow): { versionId: number | null; versionName: string | null } {
  // An imported server linked to a modpack counts as that pack's version.
  const provider = instance.source === "import" ? instance.pack_link : instance.source;
  if (provider === "ftb") return { versionId: instance.ftb_version_id, versionName: instance.pack_version_name };
  if (provider === "curseforge") return { versionId: instance.cf_file_id, versionName: instance.pack_version_name };
  return { versionId: null, versionName: null };
}

/**
 * For an imported server switching to its modpack's own files: renames its
 * mods folder (rather than deleting it) so the imported jars can't clash with
 * the pack's. Returns the new name, or null if there was no mods folder.
 */
export async function setAsideMods(instance: InstanceRow): Promise<string | null> {
  const name = `mods.before-pack-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const output = await runInVolume(instance, `if [ -d /data/mods ]; then mv /data/mods ${q(`/data/${name}`)} && echo moved; fi`).catch(
    (err: Error) => {
      throw new Error(`Couldn't set the imported mods aside (${err.message})`);
    }
  );
  return output.includes("moved") ? name : null;
}

/**
 * Archives the volume (minus re-downloadable files) and rotates old backups,
 * never rotating away `protect` (a backup about to be restored from).
 * The caller makes sure the world isn't being written meanwhile.
 */
export async function backupVolume(
  instance: InstanceRow,
  reason: BackupReason,
  label: string,
  protect?: string
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${slug(label)}.tar.gz`;
  const meta: BackupMeta = { reason, ...currentVersion(instance), createdAt: new Date().toISOString() };
  const excludes = BACKUP_EXCLUDES.map((e) => `--exclude=${q(e)}`).join(" ");
  const keepFilter = protect ? `| grep -vxF ${q(`${BACKUP_DIR}/${protect}`)}` : "";
  await runInVolume(
    instance,
    [
      "set -e",
      `mkdir -p ${BACKUP_DIR}`,
      `tar -czf ${q(`${BACKUP_DIR}/${name}.part`)} -C /data ${excludes} .`,
      `mv ${q(`${BACKUP_DIR}/${name}.part`)} ${q(`${BACKUP_DIR}/${name}`)}`,
      `printf '%s' ${q(JSON.stringify(meta))} > ${q(`${BACKUP_DIR}/${name.replace(/\.tar\.gz$/, ".json")}`)}`,
      // Newest first; drop everything past the newest BACKUPS_KEPT (and each one's sidecar).
      `ls -1t ${BACKUP_DIR}/*.tar.gz ${keepFilter} | tail -n +${BACKUPS_KEPT + 1} | while read -r f; do rm -f "$f" "\${f%.tar.gz}.json"; done`,
    ].join("\n")
  ).catch((err: Error) => {
    throw new Error(`Backup failed (${err.message})`);
  });
  return name;
}

const REASONS: readonly BackupReason[] = ["update", "manual", "restore"];

/**
 * The sidecar lives in the volume, which the modpack can write to, so it's
 * untrusted: keep only well-typed fields (anything else would break listing
 * or end up in the UI as something other than what it claims to be).
 */
function parseSidecar(text: string): Partial<BackupMeta> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {}; // unreadable sidecar: still listable/restorable, just without version info
  }
  if (!raw || typeof raw !== "object") return {};
  const { reason, versionId, versionName, createdAt } = raw as Record<string, unknown>;
  const meta: Partial<BackupMeta> = {};
  if (REASONS.includes(reason as BackupReason)) meta.reason = reason as BackupReason;
  if (Number.isSafeInteger(versionId) && (versionId as number) > 0) meta.versionId = versionId as number;
  if (typeof versionName === "string") meta.versionName = versionName.slice(0, 200);
  if (typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt))) meta.createdAt = new Date(createdAt).toISOString();
  return meta;
}

export async function listBackups(instance: InstanceRow): Promise<BackupInfo[]> {
  // One line per backup: name|size|mtime|sidecar-json (if any).
  const output = await runInVolume(
    instance,
    [
      `[ -d ${BACKUP_DIR} ] || exit 0`,
      `for f in ${BACKUP_DIR}/*.tar.gz; do`,
      `  [ -f "$f" ] || continue`,
      `  printf '%s|%s|%s|%s\\n' "$(basename "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$(cat "\${f%.tar.gz}.json" 2>/dev/null | tr -d '\\n')"`,
      "done",
    ].join("\n")
  );
  const backups: BackupInfo[] = [];
  for (const line of output.split("\n")) {
    const [name, size, mtime, ...rest] = line.split("|");
    if (!name || !NAME.test(name)) continue;
    const sidecar = rest.join("|");
    const meta = sidecar ? parseSidecar(sidecar) : {};
    backups.push({ ...meta, name, sizeBytes: Number(size), createdAt: meta.createdAt ?? new Date(Number(mtime) * 1000).toISOString() });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function requireBackup(instance: InstanceRow, name: string): Promise<BackupInfo> {
  if (!NAME.test(name)) throw new HttpError(400, "Invalid backup name.");
  const backup = (await listBackups(instance)).find((b) => b.name === name);
  if (!backup) throw new HttpError(404, "That backup doesn't exist (it may have been rotated out).");
  return backup;
}

/**
 * Replaces the world/configs with a backup's. Deletes exactly the top-level
 * paths the archive contains before extracting — extracting over a newer
 * world would mix old and new region files — and never touches mods,
 * libraries or the backups themselves. The server must be stopped.
 */
export async function extractBackup(instance: InstanceRow, name: string): Promise<void> {
  const file = `${BACKUP_DIR}/${name}`;
  const keep = NEVER_RESTORED.map((p) => `${p}`).join("|");
  await runInVolume(
    instance,
    [
      "set -e",
      `tar -tzf ${q(file)} | cut -d/ -f2 | sort -u > /tmp/top`,
      "while IFS= read -r entry; do",
      '  case "$entry" in ""|.|..) continue ;; esac',
      `  case "$entry" in ${keep}) continue ;; esac`,
      '  rm -rf -- "/data/$entry"',
      "done < /tmp/top",
      `tar -xzf ${q(file)} -C /data --exclude=./.update-backups --exclude=./mods --exclude=./libraries`,
    ].join("\n")
  ).catch((err: Error) => {
    throw new Error(`Restore failed (${err.message})`);
  });
}

/**
 * For backing up a running server: stop autosaves and flush the world to
 * disk first, so the archive isn't taken mid-write. Returns the function
 * that turns saving back on.
 */
export async function pauseSaving(instance: InstanceRow): Promise<() => Promise<void>> {
  // A server that only just reported "Done" may not have its RCON listener up yet — give it a few seconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await sendConsoleCommand(instance.container_name, instance.rcon_password, "save-off");
      await sendConsoleCommand(instance.container_name, instance.rcon_password, "save-all flush");
      break;
    } catch {
      if (attempt >= 5) {
        throw new HttpError(409, "Couldn't reach the server over RCON to pause saving. Stop the server and back it up instead.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 3000)); // older versions don't block on "flush"
  return async () => {
    await sendConsoleCommand(instance.container_name, instance.rcon_password, "save-on").catch(() => undefined);
  };
}
