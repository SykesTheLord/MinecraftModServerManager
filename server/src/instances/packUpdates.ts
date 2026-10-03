import { env } from "../config/env.js";
import { docker } from "../docker/dockerClient.js";
import { STOP_TIMEOUT_SECONDS } from "../docker/containerSpec.js";
import { ensureImagePulled } from "../docker/images.js";
import { javaMajorForMinecraftVersion, resolveMinecraftImage } from "../docker/javaImage.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { getModpackJavaMajorVersion, listAllModpacks, listModpackVersions } from "../ftb/ftbCatalogClient.js";
import { getCfFile, getCfModpack, listCfModpackFiles } from "../curseforge/cfClient.js";
import { installCurseForgeInstance, isInstallRunning } from "../curseforge/cfInstaller.js";
import { HttpError } from "../http/errors.js";
import { removeInstanceRoute } from "../infrared/configWriter.js";
import { appLogger } from "../logging/appLogger.js";
import { stopPersistingInstanceLogs } from "../logging/instanceLogWriter.js";
import { sendConsoleCommand } from "../rcon/rconClient.js";
import { stopHealthPolling } from "./healthPoller.js";
import { backupVolume, extractBackup, pauseSaving, requireBackup, setAsideMods } from "./backups.js";
import { instanceService, provisionInstance } from "./instanceService.js";

/**
 * Modpack updates for FTB and CurseForge servers (imports have no upstream).
 *
 * Applying an update = stop the server, back up its world/configs inside its
 * volume, remove the container, point the row at the new version, and
 * re-provision. The volume is kept, so the world carries over:
 * - FTB: itzg re-runs FTB's own installer (with -force) whenever its install
 *   marker stops matching FTB_MODPACK_ID=FTB_MODPACK_VERSION_ID — confirmed
 *   in the image's start-deployFTBA — which swaps the pack's files over.
 * - CurseForge: the install container runs again with the new file id;
 *   mc-image-helper removes the old version's files using its own manifest.
 *
 * Automatic updates are deliberately conservative: only *release* versions,
 * only on the *same Minecraft version* (a Minecraft upgrade can be one-way
 * for a world, so that stays a manual decision), only while the server is
 * running with nobody online (checked over RCON) — an update means a restart
 * — and, if the admin set one, only inside their time-of-day window.
 * Stopped servers are left alone; busy ones are retried on the next tick.
 *
 * Backups and restores (instances/backups.ts) share this module's per-server
 * lock, so an update, a restore and a backup never overlap on one server.
 */

export interface PackVersionOption {
  id: number;
  name: string;
  minecraftVersion: string | null;
  /** Epoch ms. */
  date: number;
  release: boolean;
}

// Short enough that a time window of half an hour or so is never missed.
const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000;

/** Servers with an update, restore or backup in progress — one at a time per server. */
const busy = new Set<string>();

export function isUpdating(instanceId: string): boolean {
  return busy.has(instanceId);
}

async function withServerLock<T>(instanceId: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(instanceId)) throw new HttpError(409, "An update, restore or backup is already running for this server.");
  busy.add(instanceId);
  try {
    return await work();
  } finally {
    busy.delete(instanceId);
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validateUpdateWindow(window: { start: string; end: string; timeZone: string }): void {
  if (!HHMM.test(window.start) || !HHMM.test(window.end)) throw new HttpError(400, "Window times must be HH:MM (24-hour).");
  if (window.start === window.end) throw new HttpError(400, "The window's start and end must differ.");
  if (!isValidTimeZone(window.timeZone)) throw new HttpError(400, `Unknown time zone "${window.timeZone}".`);
}

/**
 * Whether `now` falls inside the instance's automatic-update window (always
 * true without one). Evaluated in the window's own time zone — the manager
 * runs in UTC — and windows may cross midnight (22:00–06:00).
 */
export function isWithinUpdateWindow(instance: InstanceRow, now = new Date()): boolean {
  const { update_window_start: start, update_window_end: end, update_window_tz: timeZone } = instance;
  if (!start || !end || !timeZone) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const local = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

/**
 * Which modpack a server follows: its own source for FTB/CurseForge servers,
 * or — for an imported server — the pack it was linked to. Null if none.
 */
export function packProvider(instance: Pick<InstanceRow, "source" | "pack_link">): "ftb" | "curseforge" | null {
  if (instance.source === "ftb" || instance.source === "curseforge") return instance.source;
  return instance.source === "import" ? instance.pack_link : null;
}

export interface PackLink {
  provider: "ftb" | "curseforge";
  packId: number;
  packName: string;
  versionId: number;
  versionName: string;
}

/**
 * Checks that a pack and version exist (with the provider's own names for
 * them), for linking an imported server to the modpack it is.
 */
export async function resolvePackLink(provider: "ftb" | "curseforge", packId: number, versionId: number): Promise<PackLink> {
  if (provider === "ftb") {
    const [packs, versions] = await Promise.all([listAllModpacks(), listModpackVersions(packId)]);
    const pack = packs.find((p) => p.id === packId);
    const version = versions.find((v) => v.id === versionId);
    if (!pack || !version) throw new HttpError(404, "That FTB modpack or version doesn't exist.");
    return { provider, packId, packName: pack.name, versionId, versionName: version.name };
  }
  const [pack, file] = await Promise.all([getCfModpack(packId), getCfFile(packId, versionId)]);
  return { provider, packId, packName: pack.name, versionId, versionName: file.displayName };
}

function updatable(instance: InstanceRow): boolean {
  return packProvider(instance) !== null;
}

function currentVersionId(instance: InstanceRow): number | null {
  const provider = packProvider(instance);
  return provider === "ftb" ? instance.ftb_version_id : provider === "curseforge" ? instance.cf_file_id : null;
}

/**
 * Every version of the instance's pack, newest first. CurseForge's list is
 * reused for up to 12 hours (its API limits requests); `refresh` — only for
 * an admin's explicit force-refresh — fetches it again. FTB's is always live.
 */
export async function listPackVersions(instance: InstanceRow, options: { refresh?: boolean } = {}): Promise<PackVersionOption[]> {
  const provider = packProvider(instance);
  if (provider === "ftb") {
    return (await listModpackVersions(instance.ftb_modpack_id)).map((v) => ({
      id: v.id,
      name: v.name,
      minecraftVersion: v.minecraftVersion,
      date: (v.updatedAt ?? 0) * 1000,
      release: v.type === "release",
    }));
  }
  if (provider === "curseforge" && instance.cf_mod_id) {
    return (await listCfModpackFiles(instance.cf_mod_id, options)).map((f) => ({
      id: f.id,
      name: f.displayName,
      minecraftVersion: f.minecraftVersion,
      date: Date.parse(f.date),
      release: f.releaseType === "release",
    }));
  }
  throw new HttpError(400, "Only FTB and CurseForge servers have versions to update to.");
}

async function findCurrent(instance: InstanceRow, versions: PackVersionOption[]): Promise<PackVersionOption | null> {
  const id = currentVersionId(instance);
  const found = versions.find((v) => v.id === id);
  if (found || packProvider(instance) !== "curseforge" || !id) return found ?? null;
  // Older than the newest-100 window the file list covers.
  const file = await getCfFile(instance.cf_mod_id!, id).catch(() => null);
  return file
    ? { id: file.id, name: file.displayName, minecraftVersion: file.minecraftVersion, date: Date.parse(file.date), release: file.releaseType === "release" }
    : null;
}

/** The newest release version newer than the installed one, on the same Minecraft version. */
export async function findUpdate(instance: InstanceRow, options: { refresh?: boolean } = {}): Promise<PackVersionOption | null> {
  const versions = await listPackVersions(instance, options);
  const current = await findCurrent(instance, versions);
  if (!current) return null;
  return (
    versions
      .filter((v) => v.release && v.date > current.date && v.minecraftVersion === current.minecraftVersion)
      .sort((a, b) => b.date - a.date)[0] ?? null
  );
}

export async function checkForUpdate(instanceId: string, options: { refresh?: boolean } = {}): Promise<InstanceRow> {
  const instance = instanceRepo.findById(instanceId);
  if (!instance) throw new HttpError(404, "Instance not found.");
  if (!updatable(instance)) {
    throw new HttpError(
      400,
      instance.source === "import"
        ? "Link this server to the modpack it is first (Updates tab)."
        : "Only FTB and CurseForge servers can be updated."
    );
  }
  const available = await findUpdate(instance, options);
  instanceRepo.setUpdateCheck(instanceId, available ? { id: available.id, name: available.name } : null);
  return instanceRepo.findById(instanceId)!;
}

/** Players online, via RCON `list` ("There are 0 of a max of 20 players online" / "There are 0/20 players online"). */
async function playersOnline(instance: InstanceRow): Promise<number | null> {
  try {
    const reply = await sendConsoleCommand(instance.container_name, instance.rcon_password, "list");
    const match = /There are (\d+)/i.exec(reply);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function packDisplayName(instance: InstanceRow): Promise<string> {
  if (packProvider(instance) === "curseforge") return (await getCfModpack(instance.cf_mod_id!)).name;
  if (instance.linked_pack_name) return instance.linked_pack_name;
  const pack = (await listAllModpacks().catch(() => [])).find((p) => p.id === instance.ftb_modpack_id);
  return pack?.name ?? instance.ftb_pack_name.replace(/\s*\([^)]*\)$/, "");
}

/**
 * Moves an instance to another version of its pack (newer or older; manual
 * updates may also change Minecraft version). Resolves once the new server
 * is starting (FTB) or its install has begun (CurseForge).
 */
export async function applyPackUpdate(instanceId: string, versionId: number, trigger: "manual" | "auto"): Promise<void> {
  await withServerLock(instanceId, () => applyPackUpdateLocked(instanceId, versionId, trigger, { backup: true }));
}

async function applyPackUpdateLocked(
  instanceId: string,
  versionId: number,
  trigger: "manual" | "auto" | "restore",
  options: { backup: boolean; /** Prefixed to the outcome message (e.g. what a restore did first). */ note?: string }
): Promise<void> {
  const instance = instanceRepo.findById(instanceId);
  try {
    if (!instance) throw new HttpError(404, "Instance not found.");
    const provider = packProvider(instance);
    if (!provider) throw new HttpError(400, "Only FTB and CurseForge servers (or imported servers linked to one) can be updated.");
    if (instance.status === "stopping") throw new HttpError(409, "The server is stopping — try again once it has stopped.");
    if (instance.status === "creating" || isInstallRunning(instanceId)) {
      throw new HttpError(409, "The server is still being installed.");
    }
    // An imported server's first update switches it to running the pack itself.
    const converting = instance.source === "import";

    const versions = await listPackVersions(instance);
    const target = versions.find((v) => v.id === versionId);
    if (!target) throw new HttpError(404, "That version isn't available for this pack.");
    // A failed update leaves no container behind; re-applying the same version is how it's retried.
    if (target.id === currentVersionId(instance) && instance.container_id && trigger !== "restore") {
      throw new HttpError(409, `Already on ${target.name}.`);
    }

    const current = await findCurrent(instance, versions);
    const sameMinecraft = current?.minecraftVersion === target.minecraftVersion;
    const image =
      provider === "ftb"
        ? resolveMinecraftImage(await getModpackJavaMajorVersion(instance.ftb_modpack_id, target.id).catch(() => null))
        : sameMinecraft
          ? instance.image // keeps a Java version the admin picked
          : resolveMinecraftImage(javaMajorForMinecraftVersion(target.minecraftVersion));
    const fromName = instance.pack_version_name ?? "the previous version";
    const packName = await packDisplayName(instance);
    await ensureImagePulled(image);

    appLogger.info({ instanceId, from: fromName, to: target.name, trigger }, "updating modpack");
    instanceRepo.setUpdateResult(instanceId, `Updating from ${fromName} to ${target.name}…`);
    stopHealthPolling(instanceId);
    stopPersistingInstanceLogs(instanceId);
    removeInstanceRoute(instanceId);
    const wasRunning = instance.status === "running" || instance.status === "installing";
    instanceRepo.updateStatus(instanceId, "creating");

    const old = instance.container_id ? docker.getContainer(instance.container_id) : null;
    await old?.stop({ t: STOP_TIMEOUT_SECONDS }).catch(() => undefined);
    let backupName: string | null = null;
    let setAside: string | null = null;
    try {
      // A restore that switches versions has just backed up, and the volume now *is* a backup.
      if (options.backup) backupName = await backupVolume(instance, "update", `before-${fromName}`);
      // The pack brings its own mods; the imported ones are kept, renamed, rather than left to clash with them.
      if (converting) setAside = await setAsideMods(instance);
    } catch (err) {
      // Nothing has changed yet: put the server back the way it was.
      instanceRepo.updateStatus(instanceId, old ? "stopped" : "error", old ? null : (err as Error).message);
      if (old && wasRunning) await instanceService.startInstance(instanceId).catch(() => undefined);
      throw err;
    }
    await old?.remove().catch(() => undefined);

    if (converting) instanceRepo.convertLinkedImport(instanceId);
    instanceRepo.setPackVersion(instanceId, {
      versionId: target.id,
      versionName: target.name,
      packName: `${packName} (${target.name})`,
      image,
      containerId: null,
    });
    const how = trigger === "auto" ? "automatically" : trigger === "restore" ? "to match a restored backup" : "manually";
    const backupNote = backupName ? ` Backup: ${backupName}` : "";
    const conversionNote = converting
      ? `It now runs ${packName}'s own files${setAside ? `; the imported mods are kept in ${setAside}` : ""}. `
      : "";
    const prefix = `${options.note ? `${options.note} ` : ""}${conversionNote}`;
    const done = `${prefix}Updated from ${fromName} to ${target.name} (${how}, ${new Date().toISOString()}).${backupNote}`;

    if (provider === "ftb") {
      await provisionInstance(instanceId);
      instanceRepo.setUpdateResult(instanceId, done);
    } else {
      void installCurseForgeInstance(instanceId, (row) => provisionInstance(row.id).then(() => undefined)).then(() => {
        const after = instanceRepo.findById(instanceId);
        if (!after) return;
        instanceRepo.setUpdateResult(
          instanceId,
          after.container_id ? done : `${prefix}Update to ${target.name} is waiting on the install — see "Modpack install".${backupNote}`
        );
      });
    }
  } catch (err) {
    if (instance && instanceRepo.findById(instanceId)) {
      instanceRepo.setUpdateResult(instanceId, `Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }
}

/** Stops tracking a server and stops its container; returns whether it had been running. */
async function takeDown(instance: InstanceRow): Promise<boolean> {
  stopHealthPolling(instance.id);
  stopPersistingInstanceLogs(instance.id);
  removeInstanceRoute(instance.id);
  const wasRunning = instance.status === "running" || instance.status === "installing";
  if (instance.container_id) {
    await docker.getContainer(instance.container_id).stop({ t: STOP_TIMEOUT_SECONDS }).catch(() => undefined);
  }
  return wasRunning;
}

/**
 * Restores a backup over the server's world and configs. The current state is
 * backed up first (so a restore can be undone too). If the backup was taken
 * on a different pack version and `switchVersion` is set, the pack is then
 * moved back to that version — otherwise the restored world would run
 * against the newer mods it was backed up away from.
 */
export async function restoreBackup(instanceId: string, name: string, switchVersion: boolean): Promise<void> {
  await withServerLock(instanceId, async () => {
    const instance = instanceRepo.findById(instanceId);
    if (!instance) throw new HttpError(404, "Instance not found.");
    if (instance.status === "stopping") throw new HttpError(409, "The server is stopping — try again once it has stopped.");
    if (instance.status === "creating" || isInstallRunning(instanceId)) {
      throw new HttpError(409, "The server is being installed; restore once that's finished.");
    }
    const backup = await requireBackup(instance, name);
    const targetVersion =
      switchVersion && updatable(instance) && backup.versionId && backup.versionId !== currentVersionId(instance)
        ? backup.versionId
        : null;
    if (targetVersion && !(await listPackVersions(instance)).some((v) => v.id === targetVersion)) {
      throw new HttpError(409, `${backup.versionName ?? "The backup's version"} is no longer available for this pack; restore without switching versions.`);
    }

    instanceRepo.setUpdateResult(instanceId, `Restoring ${name}…`);
    instanceRepo.updateStatus(instanceId, "creating");
    const wasRunning = await takeDown(instance);
    let safety: string;
    try {
      safety = await backupVolume(instance, "restore", "before-restore", name);
    } catch (err) {
      instanceRepo.updateStatus(instanceId, instance.container_id ? "stopped" : instance.status);
      if (wasRunning && instance.container_id) await instanceService.startInstance(instanceId).catch(() => undefined);
      instanceRepo.setUpdateResult(instanceId, `Restore failed before changing anything: ${(err as Error).message}`);
      throw err;
    }
    try {
      await extractBackup(instance, name);
    } catch (err) {
      instanceRepo.updateStatus(instanceId, instance.container_id ? "stopped" : "error", (err as Error).message);
      instanceRepo.setUpdateResult(
        instanceId,
        `Restore of ${name} failed partway (${(err as Error).message}). The state from just before is saved as ${safety} — restore that to go back.`
      );
      throw err;
    }
    appLogger.info({ instanceId, backup: name, safety, switchVersion: targetVersion }, "restored backup");

    const restored = `Restored ${name} (${new Date().toISOString()}). The state from just before is saved as ${safety}.`;
    if (targetVersion) {
      instanceRepo.updateStatus(instanceId, "stopped");
      // The outcome message is set when the reinstall finishes (asynchronously for CurseForge).
      await applyPackUpdateLocked(instanceId, targetVersion, "restore", { backup: false, note: restored });
      return;
    }
    instanceRepo.updateStatus(instanceId, instance.container_id ? "stopped" : instance.status);
    if (wasRunning && instance.container_id) await instanceService.startInstance(instanceId);
    instanceRepo.setUpdateResult(instanceId, restored);
  });
}

/** An on-demand backup. A running server keeps running: saving is paused and flushed around the archive. */
export async function createManualBackup(instanceId: string): Promise<string> {
  return withServerLock(instanceId, async () => {
    const instance = instanceRepo.findById(instanceId);
    if (!instance) throw new HttpError(404, "Instance not found.");
    if (instance.status === "creating" || instance.status === "installing" || instance.status === "stopping") {
      throw new HttpError(409, "The server is starting, stopping or installing — back it up once it's running, or stopped.");
    }
    const resume = instance.status === "running" && instance.container_id ? await pauseSaving(instance) : null;
    try {
      return await backupVolume(instance, "manual", "manual");
    } finally {
      await resume?.();
    }
  });
}

let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const intervalMs = env.PACK_UPDATE_CHECK_HOURS * 3600 * 1000;
    for (const instance of instanceRepo.list()) {
      if (!updatable(instance) || instance.auto_update === "off") continue;
      // A linked imported server is only checked: its first update converts it, so that's done by hand.
      let row = instance;
      const due = !row.update_checked_at || Date.now() - Date.parse(row.update_checked_at) >= intervalMs;
      if (due) {
        row = await checkForUpdate(row.id).catch((err) => {
          appLogger.warn({ err, instanceId: row.id }, "modpack update check failed");
          return row;
        });
      }
      if (row.auto_update !== "auto" || row.source === "import" || !row.available_version_id || row.status !== "running" || busy.has(row.id)) {
        continue;
      }
      if (!isWithinUpdateWindow(row)) {
        appLogger.info(
          { instanceId: row.id, update: row.available_version_name, window: `${row.update_window_start}-${row.update_window_end} ${row.update_window_tz}` },
          "auto-update waiting for its time window"
        );
        continue;
      }
      const players = await playersOnline(row);
      if (players !== 0) {
        // Busy, or the player count couldn't be read — never restart a server that might have players. Next tick retries.
        appLogger.info(
          { instanceId: row.id, players, update: row.available_version_name },
          players === null ? "auto-update waiting: couldn't read the player count over RCON" : "auto-update waiting for the server to empty"
        );
        continue;
      }
      await applyPackUpdate(row.id, row.available_version_id, "auto").catch((err) =>
        appLogger.error({ err, instanceId: row.id }, "automatic modpack update failed")
      );
    }
  } finally {
    ticking = false;
  }
}

export function startPackUpdateScheduler(): void {
  if (env.PACK_UPDATE_CHECK_HOURS <= 0) {
    appLogger.info("modpack update checks disabled (PACK_UPDATE_CHECK_HOURS=0)");
    return;
  }
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
  setInterval(() => void tick(), TICK_MS).unref();
}
