import crypto from "node:crypto";
import { docker } from "../docker/dockerClient.js";
import { buildContainerConfig, STOP_TIMEOUT_SECONDS } from "../docker/containerSpec.js";
import { ensureImagePulled } from "../docker/images.js";
import { resolveMinecraftImage } from "../docker/javaImage.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { writeInstanceRoute, removeInstanceRoute } from "../infrared/configWriter.js";
import { startPersistingInstanceLogs, stopPersistingInstanceLogs } from "../logging/instanceLogWriter.js";
import { startHealthPolling, stopHealthPolling } from "./healthPoller.js";
import { appLogger } from "../logging/appLogger.js";
import { getRecentLogs } from "../docker/logsStream.js";
import { getModpackJavaMajorVersion } from "../ftb/ftbCatalogClient.js";
import { HttpError } from "../http/errors.js";

export interface CreateInstanceInput {
  name: string;
  subdomain: string;
  ftbModpackId: number;
  ftbVersionId: number;
  ftbPackName: string;
  memoryMb: number;
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

export const instanceService = {
  async createInstance(input: CreateInstanceInput): Promise<InstanceRow> {
    validateSubdomain(input.subdomain);
    if (instanceRepo.findBySubdomain(input.subdomain)) {
      throw new HttpError(409, `Subdomain "${input.subdomain}" is already in use.`);
    }

    const id = crypto.randomUUID();
    const containerName = `mc-${id}`;
    const volumeName = `mc-data-${id}`;
    const rconPassword = crypto.randomBytes(16).toString("hex");

    const javaMajor = await getModpackJavaMajorVersion(input.ftbModpackId, input.ftbVersionId).catch(() => null);
    const image = resolveMinecraftImage(javaMajor);

    instanceRepo.create({
      id,
      name: input.name,
      subdomain: input.subdomain,
      ftbModpackId: input.ftbModpackId,
      ftbVersionId: input.ftbVersionId,
      ftbPackName: input.ftbPackName,
      memoryMb: input.memoryMb,
      image,
      containerName,
      volumeName,
      rconPassword,
    });

    try {
      await ensureImagePulled(image);
      await docker.createVolume({ Name: volumeName });

      const instance = instanceRepo.findById(id)!;
      const container = await docker.createContainer(buildContainerConfig(instance));
      instanceRepo.setContainerId(id, container.id);
      await container.start();

      instanceRepo.updateStatus(id, "installing");
      writeInstanceRoute(id, input.subdomain, containerName);
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
  },

  async startInstance(id: string): Promise<void> {
    const instance = requireInstance(id);
    if (!instance.container_id) throw new HttpError(409, "Instance has no container yet.");
    // The DB can lag behind Docker (e.g. `unless-stopped` relaunched a
    // container the health poller had already marked as errored), so
    // "already started" (304) just means there's nothing to do but resume
    // tracking it.
    await docker
      .getContainer(instance.container_id)
      .start()
      .catch((err: { statusCode?: number }) => {
        if (err?.statusCode !== 304) throw err;
      });
    instanceRepo.updateStatus(id, "installing");
    writeInstanceRoute(id, instance.subdomain, instance.container_name);
    startPersistingInstanceLogs(id, instance.container_id);
    startHealthPolling(id);
  },

  async stopInstance(id: string): Promise<void> {
    const instance = requireInstance(id);
    if (instance.container_id) {
      await docker
        .getContainer(instance.container_id)
        .stop({ t: STOP_TIMEOUT_SECONDS })
        .catch(() => undefined);
    }
    stopHealthPolling(id);
    stopPersistingInstanceLogs(id);
    removeInstanceRoute(id);
    instanceRepo.updateStatus(id, "stopped");
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
    if (!instance.container_id) return "";
    return getRecentLogs(instance.container_id, lines);
  },
};

function requireInstance(id: string): InstanceRow {
  const instance = instanceRepo.findById(id);
  if (!instance) throw new HttpError(404, `Instance ${id} not found.`);
  return instance;
}
