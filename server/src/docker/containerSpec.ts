import type Docker from "dockerode";
import { env } from "../config/env.js";
import type { InstanceRow } from "../db/repositories/instanceRepo.js";

/**
 * Seconds Docker waits after SIGTERM before SIGKILL. Docker's default is 10s,
 * which a large modpack often can't save its world in — a SIGKILL mid-save can
 * corrupt region files. Set on the container (so Docker's own restarts and
 * host shutdowns honor it) and passed explicitly to every stop() call (so
 * containers created before this existed get it too).
 */
export const STOP_TIMEOUT_SECONDS = 60;

/**
 * Container memory cap for an instance. MEMORY only sizes the JVM heap; the
 * process also needs metaspace, thread stacks, direct buffers and native
 * memory on top — substantial for big modpacks — so the cap leaves headroom
 * (25% or 1 GiB, whichever is larger). Without any cap, one pack (or one
 * misbehaving mod) can exhaust the host's RAM and take every other instance
 * and the manager down with it. Exceeding it OOM-kills the container, which
 * the health poller then reports like any other crash.
 */
export function containerMemoryLimitBytes(heapMb: number): number {
  const overheadMb = Math.max(1024, Math.ceil(heapMb * 0.25));
  return (heapMb + overheadMb) * 1024 * 1024;
}

/**
 * Every modpack instance runs from the same itzg/minecraft-server image
 * family; the modpack itself is selected purely via env vars (TYPE=FTBA,
 * FTB_MODPACK_ID required, FTB_MODPACK_VERSION_ID optional — defaults to
 * latest, but we always pin the version the admin picked in the wizard),
 * which the image downloads and boots at container start, auto-selecting a
 * matching Forge version. No per-modpack `docker build` step exists or is
 * needed. Confirmed against itzg's own docs:
 * https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/ftb/
 *
 * The JVM is a different story: it is selected by *image tag*, not an env
 * var, and does NOT get auto-matched to the pack — `instance.image` is
 * resolved per instance from the pack's own declared Java target before this
 * is called (see docker/javaImage.ts and instanceService.createInstance).
 * Getting this wrong is not hypothetical: it's exactly what crash-looped two
 * different real FTB packs during implementation.
 *
 * Imported instances (source = 'import', see imports/) instead run whatever
 * server files were copied into their volume, with the itzg TYPE/VERSION env
 * resolved at import time and stored in `server_env`.
 *
 * Deliberately no PortBindings: instances are only reachable from Infrared
 * over the internal mc-net network, never published to the host directly.
 */
export function buildContainerConfig(
  instance: Pick<
    InstanceRow,
    | "id"
    | "ftb_modpack_id"
    | "ftb_version_id"
    | "memory_mb"
    | "image"
    | "source"
    | "server_env"
    | "container_name"
    | "volume_name"
    | "rcon_password"
  >
): Docker.ContainerCreateOptions {
  return {
    name: instance.container_name,
    Image: instance.image,
    Env: [
      "EULA=TRUE",
      ...serverTypeEnv(instance),
      `MEMORY=${instance.memory_mb}M`,
      "ENABLE_RCON=TRUE",
      `RCON_PASSWORD=${instance.rcon_password}`,
      "RCON_PORT=25575",
    ],
    Labels: {
      "mcmgr.managed": "true",
      "mcmgr.instanceId": instance.id,
    },
    StopTimeout: STOP_TIMEOUT_SECONDS,
    HostConfig: {
      Binds: [`${instance.volume_name}:/data`],
      NetworkMode: env.DOCKER_NETWORK,
      RestartPolicy: { Name: "unless-stopped" },
      // Modpacks are hundreds of third-party mods — treat them as untrusted code.
      Memory: containerMemoryLimitBytes(instance.memory_mb),
      MemorySwap: containerMemoryLimitBytes(instance.memory_mb), // == Memory: no extra swap
      PidsLimit: 4096, // generous for a JVM's threads, but stops a fork bomb
      // itzg's entrypoint starts as root and drops to its unprivileged user
      // itself (no setuid binaries involved), so blocking privilege gain is
      // free. NET_RAW is dropped so a container can't forge packets / ARP on
      // mc-net (e.g. impersonate the gateway address the manager trusts);
      // the rest are simply never needed by a Minecraft server.
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SYS_CHROOT", "SETFCAP"],
      // No PortBindings — only Infrared is reachable from outside mc-net.
    },
  };
}

function serverTypeEnv(
  instance: Pick<InstanceRow, "ftb_modpack_id" | "ftb_version_id" | "source" | "server_env">
): string[] {
  if (instance.source === "import") {
    const serverEnv = JSON.parse(instance.server_env ?? "{}") as Record<string, string>;
    return Object.entries(serverEnv).map(([key, value]) => `${key}=${value}`);
  }
  return [
    "TYPE=FTBA",
    `FTB_MODPACK_ID=${instance.ftb_modpack_id}`,
    `FTB_MODPACK_VERSION_ID=${instance.ftb_version_id}`,
  ];
}
