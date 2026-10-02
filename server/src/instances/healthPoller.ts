import { docker } from "../docker/dockerClient.js";
import { STOP_TIMEOUT_SECONDS } from "../docker/containerSpec.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { getRecentLogs } from "../docker/logsStream.js";
import { stopPersistingInstanceLogs } from "../logging/instanceLogWriter.js";
import { removeInstanceRoute } from "../infrared/configWriter.js";
import { sendConsoleCommand } from "../rcon/rconClient.js";
import { appLogger } from "../logging/appLogger.js";

const FAST_POLL_MS = 5_000; // while installing/booting (packs can take minutes to first-boot)
const SLOW_POLL_MS = 30_000; // once running, just watching for unexpected crashes
const READY_LOG_MARKER = /Done \(.*\)!|RCON running/i;

// A `RestartPolicy: unless-stopped` container that keeps failing to boot
// (e.g. an old modpack whose Forge version is incompatible with the JVM the
// base image picked) gets relaunched by Docker itself, so State.Running is
// often true again by the time we poll — confirmed by actually watching one
// crash-loop 8+ times while still reporting Running. RestartCount is the
// only reliable signal that this is a loop rather than a slow-but-healthy boot.
const CRASH_LOOP_RESTART_THRESHOLD = 3;

const timers = new Map<string, NodeJS.Timeout>();

// RestartCount only resets on a manual start, so a long-lived server that
// crashed and recovered a few times over weeks would otherwise eventually
// trip the crash-loop threshold on its next ordinary crash. Counting from the
// value seen when the instance last reached `running` means only restarts
// during the current boot attempt count.
const restartBaselines = new Map<string, number>();

export function startHealthPolling(instanceId: string): void {
  stopHealthPolling(instanceId);
  scheduleNext(instanceId, FAST_POLL_MS);
}

export function stopHealthPolling(instanceId: string): void {
  const timer = timers.get(instanceId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(instanceId);
  }
  restartBaselines.delete(instanceId);
}

function scheduleNext(instanceId: string, delayMs: number): void {
  const timer = setTimeout(() => void poll(instanceId), delayMs);
  timers.set(instanceId, timer);
}

/**
 * The log tail alone can miss the "Done" line — a busy pack can print more
 * than the tail's worth of lines between two polls — so fall back to asking
 * the server directly: RCON only comes up once the server has finished
 * booting, and the manager reaches it over mc-net exactly like the console does.
 */
async function isServerReady(containerId: string, containerName: string, rconPassword: string, startedAt: string): Promise<boolean> {
  // Only this boot's output: after a restart the previous boot's "Done" line
  // is still in the container's log, and would promote it before it's up.
  const tail = await getRecentLogs(containerId, 50, startedAt).catch(() => "");
  if (READY_LOG_MARKER.test(tail)) return true;
  return sendConsoleCommand(containerName, rconPassword, "list").then(
    () => true,
    () => false
  );
}

/** Gives up on an instance: surfaces the error and stops everything that assumed it was up. */
function giveUp(instanceId: string, lastError: string): void {
  instanceRepo.updateStatus(instanceId, "error", lastError);
  restartBaselines.delete(instanceId);
  stopPersistingInstanceLogs(instanceId);
  removeInstanceRoute(instanceId);
}

async function logTail(containerId: string): Promise<string> {
  const tail = await getRecentLogs(containerId, 100).catch(() => "(no logs available)");
  return tail.slice(-4000);
}

async function poll(instanceId: string): Promise<void> {
  timers.delete(instanceId);
  const instance = instanceRepo.findById(instanceId);
  if (!instance || !instance.container_id) return; // deleted or never started — stop implicitly
  if (instance.status !== "installing" && instance.status !== "running") return; // stopped/errored elsewhere

  try {
    const info = await docker.getContainer(instance.container_id).inspect();
    // First poll since (re)starting to track this instance: a manual start
    // resets RestartCount, so for `installing` every restart counts; for an
    // already-`running` instance (resumed after a manager restart) only
    // restarts from here on do.
    const baseline =
      restartBaselines.get(instanceId) ?? (instance.status === "running" ? info.RestartCount : 0);
    restartBaselines.set(instanceId, baseline);
    const restartsThisBoot = info.RestartCount - baseline;

    if (instance.status === "installing" && restartsThisBoot >= CRASH_LOOP_RESTART_THRESHOLD) {
      giveUp(instanceId, await logTail(instance.container_id));
      appLogger.error({ instanceId, restartCount: info.RestartCount }, "instance crash-looping on boot");
      // Stop it explicitly — `unless-stopped` would otherwise keep relaunching
      // it forever even though we've already given up and surfaced an error.
      await docker
        .getContainer(instance.container_id)
        .stop({ t: STOP_TIMEOUT_SECONDS })
        .catch(() => undefined);
      return;
    }

    if (info.State.Running) {
      let status = instance.status;
      if (
        status === "installing" &&
        (await isServerReady(instance.container_id, instance.container_name, instance.rcon_password, info.State.StartedAt))
      ) {
        status = "running";
        instanceRepo.updateStatus(instanceId, status);
        restartBaselines.set(instanceId, info.RestartCount);
        appLogger.info({ instanceId }, "instance promoted to running");
      }
      scheduleNext(instanceId, status === "running" ? SLOW_POLL_MS : FAST_POLL_MS);
      return;
    }

    if (info.State.Restarting) {
      // Crashed, and Docker's restart policy is about to relaunch it. A
      // running server that crashed is booting again, so it's back to
      // `installing` — where the crash-loop check above applies.
      if (instance.status === "running") {
        instanceRepo.updateStatus(instanceId, "installing");
        appLogger.warn({ instanceId, exitCode: info.State.ExitCode }, "instance crashed; docker is restarting it");
      }
      scheduleNext(instanceId, FAST_POLL_MS);
      return;
    }

    // Exited and Docker isn't bringing it back (e.g. stopped outside the manager).
    giveUp(instanceId, await logTail(instance.container_id));
    appLogger.error({ instanceId, exitCode: info.State.ExitCode }, "instance container exited unexpectedly");
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) {
      giveUp(instanceId, "The instance's container no longer exists.");
      appLogger.error({ instanceId }, "instance container disappeared");
      return;
    }
    appLogger.error({ err, instanceId }, "health poll failed");
    scheduleNext(instanceId, SLOW_POLL_MS);
  }
}
