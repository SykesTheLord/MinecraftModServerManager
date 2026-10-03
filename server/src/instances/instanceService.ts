import crypto from "node:crypto";
import type Docker from "dockerode";
import { docker } from "../docker/dockerClient.js";
import { buildContainerConfig, STOP_TIMEOUT_SECONDS } from "../docker/containerSpec.js";
import { ensureImagePulled } from "../docker/images.js";
import { javaMajorForMinecraftVersion, resolveMinecraftImage } from "../docker/javaImage.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { writeInstanceRoute, removeInstanceRoute } from "../infrared/configWriter.js";
import {
  readPersistedLogTail,
  startPersistingInstanceLogs,
  stopPersistingInstanceLogs,
} from "../logging/instanceLogWriter.js";
import { cleanupCurseForgeInstall, installCurseForgeInstance, isInstallRunning } from "../curseforge/cfInstaller.js";
import { getCfFile, getCfModpack } from "../curseforge/cfClient.js";
import { getStartupQuery, markStartupQueryAnswered, startHealthPolling, stopHealthPolling } from "./healthPoller.js";
import { writeConsoleLine } from "../docker/consoleInput.js";
import { appLogger } from "../logging/appLogger.js";
import { getRecentLogs } from "../docker/logsStream.js";
import { getModpackJavaMajorVersion, listModpackVersions } from "../ftb/ftbCatalogClient.js";
import { HttpError } from "../http/errors.js";
import { prepareServerProperties, type ImportAnalysis } from "../imports/analyze.js";
import { packForContainer } from "../imports/archive.js";
import { buildImportedServerEnv, importedServerLabel, type ImportedServerSettings } from "../imports/serverEnv.js";
import type { PackLink } from "./packUpdates.js";

export interface CreateInstanceInput {
  name: string;
  subdomain: string;
  ftbModpackId: number;
  ftbVersionId: number;
  ftbPackName: string;
  memoryMb: number;
}

export interface CreateCurseForgeInstanceInput {
  name: string;
  subdomain: string;
  memoryMb: number;
  modId: number;
  fileId: number;
  /** Java major for the image tag; null picks one from the file's Minecraft version. */
  javaVersion: number | null;
}

export interface CreateImportedInstanceInput extends Omit<ImportedServerSettings, "levelName"> {
  name: string;
  subdomain: string;
  memoryMb: number;
  /** Java major for the image tag; null picks one from the Minecraft version. */
  javaVersion: number | null;
  /** The modpack (and version) this server is, if the admin said — see instanceRepo.setPackLink. */
  packLink?: PackLink | null;
}

const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_PATTERN.test(subdomain)) {
    throw new HttpError(
      400,
      "Subdomain must be a valid DNS label: lowercase letters, digits, hyphens, not starting/ending with a hyphen."
    );
  }
}

export function assertSubdomainAvailable(subdomain: string): void {
  validateSubdomain(subdomain);
  if (instanceRepo.findBySubdomain(subdomain)) {
    throw new HttpError(409, `Subdomain "${subdomain}" is already in use.`);
  }
}

/**
 * Brings a freshly inserted `creating` row up: pulls its image, creates its
 * volume and container, runs `beforeStart` (e.g. copying files into the
 * volume), then starts it and wires up routing, logs and health polling.
 */
export async function provisionInstance(id: string, beforeStart?: (container: Docker.Container) => Promise<void>): Promise<InstanceRow> {
  const instance = instanceRepo.findById(id)!;
  try {
    await ensureImagePulled(instance.image);
    await docker.createVolume({
      Name: instance.volume_name,
      // Lets scripts/cleanup.sh find every server's volume (older ones only match by name).
      Labels: { "mcmgr.managed": "true", "mcmgr.instanceId": instance.id },
    });

    const container = await docker.createContainer(buildContainerConfig(instance));
    instanceRepo.setContainerId(id, container.id);
    await beforeStart?.(container);
    await container.start();

    instanceRepo.updateStatus(id, "installing");
    writeInstanceRoute(id, instance.subdomain, instance.container_name);
    startPersistingInstanceLogs(id, container.id);
    startHealthPolling(id);

    return instanceRepo.findById(id)!;
  } catch (err) {
    appLogger.error({ err, instanceId: id }, "failed to create instance");
    const message = err instanceof Error ? err.message : String(err);
    instanceRepo.updateStatus(id, "error", message);
    // Superadmin-only path, and the Docker/pull error is exactly what the
    // admin needs to see — surfaced deliberately rather than as a bare 500.
    throw new HttpError(502, `Failed to create instance: ${message}`);
  }
}

export const instanceService = {
  async createInstance(input: CreateInstanceInput): Promise<InstanceRow> {
    assertSubdomainAvailable(input.subdomain);

    const id = crypto.randomUUID();
    const containerName = `mc-${id}`;
    const volumeName = `mc-data-${id}`;
    const rconPassword = crypto.randomBytes(16).toString("hex");

    const javaMajor = await getModpackJavaMajorVersion(input.ftbModpackId, input.ftbVersionId).catch(() => null);
    const image = resolveMinecraftImage(javaMajor);
    const versionName = await listModpackVersions(input.ftbModpackId)
      .then((versions) => versions.find((v) => v.id === input.ftbVersionId)?.name ?? null)
      .catch(() => null);

    instanceRepo.create({
      id,
      name: input.name,
      subdomain: input.subdomain,
      ftbModpackId: input.ftbModpackId,
      ftbVersionId: input.ftbVersionId,
      ftbPackName: input.ftbPackName,
      packVersionName: versionName,
      memoryMb: input.memoryMb,
      image,
      containerName,
      volumeName,
      rconPassword,
    });

    return provisionInstance(id);
  },

  /**
   * Creates an instance from an existing server's files (staged by
   * imports/importJobs.ts). Same as createInstance, except the container runs
   * the detected/chosen platform instead of an FTB pack, and the files are
   * copied into its volume before its first start — so itzg finds the mods,
   * configs and world already in place and only (re)installs the loader.
   */
  async createImportedInstance(input: CreateImportedInstanceInput, serverDir: string, analysis: ImportAnalysis): Promise<InstanceRow> {
    assertSubdomainAvailable(input.subdomain);
    const settings = { ...input, levelName: analysis.levelName };
    const serverEnv = buildImportedServerEnv(settings, analysis.jars);
    const image = resolveMinecraftImage(input.javaVersion ?? javaMajorForMinecraftVersion(input.minecraftVersion));

    const id = crypto.randomUUID();
    instanceRepo.create({
      id,
      name: input.name,
      subdomain: input.subdomain,
      ftbModpackId: 0,
      ftbVersionId: 0,
      ftbPackName: importedServerLabel(settings),
      memoryMb: input.memoryMb,
      image,
      containerName: `mc-${id}`,
      volumeName: `mc-data-${id}`,
      rconPassword: crypto.randomBytes(16).toString("hex"),
      source: "import",
      serverEnv,
    });
    if (input.packLink) instanceRepo.setPackLink(id, input.packLink);

    return provisionInstance(id, async (container) => {
      prepareServerProperties(serverDir);
      await container.putArchive(packForContainer(serverDir), { path: "/data" });
    });
  },

  /**
   * Creates a CurseForge modpack instance. Responds as soon as the row exists:
   * the install (downloading hundreds of mods) runs in the background — see
   * curseforge/cfInstaller.ts — and its progress shows up in the instance's
   * status and console log.
   */
  async createCurseForgeInstance(input: CreateCurseForgeInstanceInput): Promise<InstanceRow> {
    assertSubdomainAvailable(input.subdomain);
    const [pack, file] = await Promise.all([getCfModpack(input.modId), getCfFile(input.modId, input.fileId)]);
    const image = resolveMinecraftImage(input.javaVersion ?? javaMajorForMinecraftVersion(file.minecraftVersion));

    const id = crypto.randomUUID();
    instanceRepo.create({
      id,
      name: input.name,
      subdomain: input.subdomain,
      ftbModpackId: 0,
      ftbVersionId: 0,
      ftbPackName: `${pack.name} (${file.displayName})`,
      packVersionName: file.displayName,
      memoryMb: input.memoryMb,
      image,
      containerName: `mc-${id}`,
      volumeName: `mc-data-${id}`,
      rconPassword: crypto.randomBytes(16).toString("hex"),
      source: "curseforge",
      cfModId: input.modId,
      cfFileId: input.fileId,
    });
    void installCurseForgeInstance(id, (instance) => provisionInstance(instance.id).then(() => undefined));
    return instanceRepo.findById(id)!;
  },

  /** Re-runs a CurseForge install that's waiting for manual downloads, or that failed before its server existed. */
  async retryCurseForgeInstall(id: string): Promise<void> {
    const instance = requireInstance(id);
    if (instance.source !== "curseforge" || instance.container_id) {
      throw new HttpError(409, "Only a CurseForge instance whose install hasn't completed can be re-installed.");
    }
    if (isInstallRunning(id)) throw new HttpError(409, "An install is already running for this instance.");
    void installCurseForgeInstance(id, (row) => provisionInstance(row.id).then(() => undefined));
  },

  async startInstance(id: string): Promise<void> {
    const instance = requireInstance(id);
    if (!instance.container_id) throw new HttpError(409, "Instance has no container yet.");
    if (instance.status === "stopping") throw new HttpError(409, "The server is still stopping — start it again once it has stopped.");
    let containerId = instance.container_id;
    // Containers made before console input existed have no stdin to type into: recreate them from the
    // current spec (everything that matters is in the volume) the next time they start from stopped.
    const info = await docker.getContainer(containerId).inspect().catch(() => null);
    if (info && !info.State.Running && (!info.Config.OpenStdin || info.Config.StdinOnce)) {
      await docker.getContainer(containerId).remove({ force: true });
      await ensureImagePulled(instance.image);
      containerId = (await docker.createContainer(buildContainerConfig(instance))).id;
      instanceRepo.setContainerId(id, containerId);
      appLogger.info({ instanceId: id }, "recreated container with console input");
    }
    // The DB can lag behind Docker (e.g. `unless-stopped` relaunched a
    // container the health poller had already marked as errored), so
    // "already started" (304) just means there's nothing to do but resume
    // tracking it.
    await docker
      .getContainer(containerId)
      .start()
      .catch((err: { statusCode?: number }) => {
        if (err?.statusCode !== 304) throw err;
      });
    instanceRepo.updateStatus(id, "installing");
    writeInstanceRoute(id, instance.subdomain, instance.container_name);
    startPersistingInstanceLogs(id, containerId);
    startHealthPolling(id);
  },

  /**
   * Answers the question a server is waiting on before it can finish starting
   * (Forge's missing-registry-entries prompt). "confirm" removes those entries
   * from the world and lets it carry on; "cancel" aborts startup — and then
   * stops the server, or Docker's restart policy would just boot it back into
   * the same question.
   */
  async answerStartupQuery(id: string, answer: "confirm" | "cancel"): Promise<void> {
    const instance = requireInstance(id);
    if (!instance.container_id || !getStartupQuery(id)) throw new HttpError(409, "This server isn't waiting on a question.");
    await writeConsoleLine(instance.container_id, `fml ${answer}`);
    markStartupQueryAnswered(id);
    appLogger.info({ instanceId: id, answer }, "answered startup question");
    if (answer === "cancel") {
      instanceService.stopInstance(id).catch((err: unknown) => appLogger.error({ err, instanceId: id }, "stop after cancel failed"));
    }
  },

  /**
   * Stops a server gracefully (it saves first, which can take up to a minute).
   * `stopping` is recorded before anything awaits — so a caller that doesn't
   * wait for the stop (the Stop button) still has it saved by the time it
   * responds — and `stopped` only once the container is down, unless
   * something else (a delete, update or restore) took the server over meanwhile.
   */
  async stopInstance(id: string): Promise<void> {
    const instance = requireInstance(id);
    // Stop watching *before* stopping, or the health poller would record the exit as a crash.
    stopHealthPolling(id);
    instanceRepo.updateStatus(id, "stopping");
    if (instance.container_id) {
      await docker
        .getContainer(instance.container_id)
        .stop({ t: STOP_TIMEOUT_SECONDS })
        .catch(() => undefined);
    }
    // Only now: the server kicks its players itself as it shuts down, rather than the proxy dropping them.
    stopPersistingInstanceLogs(id);
    removeInstanceRoute(id);
    instanceRepo.setStatusIf(id, "stopping", "stopped");
  },

  async restartInstance(id: string): Promise<void> {
    await instanceService.stopInstance(id);
    await instanceService.startInstance(id);
  },

  async deleteInstance(id: string, deleteWorldData: boolean): Promise<void> {
    const instance = requireInstance(id);
    stopHealthPolling(id);
    stopPersistingInstanceLogs(id);
    removeInstanceRoute(id);

    if (instance.container_id) {
      const container = docker.getContainer(instance.container_id);
      await container.stop({ t: STOP_TIMEOUT_SECONDS }).catch(() => undefined);
      await container.remove().catch(() => undefined);
    }

    if (instance.source === "curseforge") await cleanupCurseForgeInstall(id);

    if (deleteWorldData) {
      await docker.getVolume(instance.volume_name).remove().catch(() => undefined);
    }

    instanceRepo.delete(id);
  },

  async updateSubdomain(id: string, subdomain: string): Promise<void> {
    validateSubdomain(subdomain);
    const existing = instanceRepo.findBySubdomain(subdomain);
    if (existing && existing.id !== id) {
      throw new HttpError(409, `Subdomain "${subdomain}" is already in use.`);
    }
    const instance = requireInstance(id);
    instanceRepo.updateSubdomain(id, subdomain);
    if (instance.status === "running" || instance.status === "installing") {
      writeInstanceRoute(id, subdomain, instance.container_name);
    }
  },

  async getRecentLogTail(id: string, lines = 200): Promise<string> {
    const instance = requireInstance(id);
    // No server container yet: a CurseForge install's output is all there is.
    if (!instance.container_id) return readPersistedLogTail(id, lines);
    return getRecentLogs(instance.container_id, lines);
  },
};

function requireInstance(id: string): InstanceRow {
  const instance = instanceRepo.findById(id);
  if (!instance) throw new HttpError(404, `Instance ${id} not found.`);
  return instance;
}
