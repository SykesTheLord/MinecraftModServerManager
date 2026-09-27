import { docker } from "./dockerClient.js";
import { env } from "../config/env.js";
import { appLogger } from "../logging/appLogger.js";

export async function ensureNetworkExists(): Promise<void> {
  const networks = await docker.listNetworks({
    filters: JSON.stringify({ name: [env.DOCKER_NETWORK] }),
  });
  const exists = networks.some((n) => n.Name === env.DOCKER_NETWORK);
  if (exists) return;

  await docker.createNetwork({ Name: env.DOCKER_NETWORK, Driver: "bridge" });
  appLogger.info({ network: env.DOCKER_NETWORK }, "created docker network");
}
