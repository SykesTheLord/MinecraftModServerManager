import { docker } from "../docker/dockerClient.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { startPersistingInstanceLogs } from "../logging/instanceLogWriter.js";
import { removeInstanceRoute, writeInstanceRoute } from "../infrared/configWriter.js";
import { startHealthPolling } from "./healthPoller.js";
import { appLogger } from "../logging/appLogger.js";

/**
 * Docker is the source of truth for real container state; the DB is a
 * control-plane cache. Runs once on manager boot so a manager restart (or a
 * manual `docker stop`/`docker start`/`docker rm` while the manager was down)
 * doesn't leave stale status in the UI, so Infrared routes match what's
 * actually up, and so log persistence/health polling resume for anything
 * that's actually still running.
 */
export async function reconcileInstancesOnBoot(): Promise<void> {
  for (const instance of instanceRepo.list()) {
    if (!instance.container_id) {
      // The manager died mid-creation (before the container existed); nothing
      // will ever move this row forward on its own.
      if (instance.status === "creating") {
        instanceRepo.updateStatus(
          instance.id,
          "error",
          instance.source === "curseforge"
            ? "The manager restarted while this modpack was being installed. Retry the install."
            : "The manager restarted before this instance finished being created."
        );
        appLogger.warn({ instanceId: instance.id }, "reconciled interrupted creation to error on boot");
      }
      continue;
    }

    let running = false;
    try {
      const info = await docker.getContainer(instance.container_id).inspect();
      running = info.State.Running || info.State.Restarting;
    } catch {
      running = false; // container no longer exists
    }

    if (running) {
      if (instance.status !== "running" && instance.status !== "installing") {
        // Started outside the manager, or relaunched by Docker's restart
        // policy after we'd marked it errored — treat it as booting and let
        // the health poller promote it once it's actually ready.
        instanceRepo.updateStatus(instance.id, "installing");
        appLogger.warn({ instanceId: instance.id, was: instance.status }, "reconciled running container to installing on boot");
      }
      writeInstanceRoute(instance.id, instance.subdomain, instance.container_name);
      startPersistingInstanceLogs(instance.id, instance.container_id);
      startHealthPolling(instance.id);
      continue;
    }

    removeInstanceRoute(instance.id);
    if (instance.status === "running" || instance.status === "installing" || instance.status === "creating") {
      instanceRepo.updateStatus(instance.id, "stopped");
      appLogger.warn({ instanceId: instance.id }, "reconciled stale status to stopped on boot");
    }
  }
}
