import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { appLogger } from "../logging/appLogger.js";

fs.mkdirSync(env.INFRARED_CONFIG_DIR, { recursive: true });

function routeFilePath(instanceId: string): string {
  return path.join(env.INFRARED_CONFIG_DIR, `${instanceId}.json`);
}

const PLACEHOLDER_FILENAME = "_placeholder.json";

/**
 * Infrared v1.3.4's gateway fatally exits ("no proxies in gateway") if its
 * config directory has zero proxy configs at startup — confirmed by actually
 * running it empty. Since a fresh install has no instances yet, we must keep
 * one permanent, harmless placeholder route around at all times so Infrared
 * always has something to load; it never matches a real subdomain and proxies
 * to a closed local port so a stray match just fails to connect.
 */
export function ensurePlaceholderRoute(): void {
  const filePath = path.join(env.INFRARED_CONFIG_DIR, PLACEHOLDER_FILENAME);
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(
    filePath,
    JSON.stringify({ domainName: "placeholder.invalid", listenTo: ":25565", proxyTo: "127.0.0.1:1" }, null, 2),
    "utf8"
  );
}

/**
 * Writes one Infrared proxy config per instance, mapping its public
 * subdomain to the instance's internal mc-net address. This targets Infrared
 * v1.3.4 specifically (pinned in docker-compose.yml): its config loader
 * watches this directory via fsnotify and hot-reloads on change with no
 * restart, but it expects JSON files with these exact field names
 * (domainName/listenTo/proxyTo) — confirmed against the v1.3.4 source at
 * https://github.com/haveachin/infrared/blob/v1.3.4/config.go. The current
 * `master`/2.x branch is a rewrite with a different (YAML) schema and, as of
 * this writing, no hot-reload at all — do not upgrade the pinned image tag
 * without re-verifying this file against whatever version is deployed.
 */
export function writeInstanceRoute(instanceId: string, subdomain: string, containerName: string): void {
  const config = {
    domainName: subdomain,
    listenTo: ":25565",
    proxyTo: `${containerName}:25565`,
  };

  fs.writeFileSync(routeFilePath(instanceId), JSON.stringify(config, null, 2), "utf8");
  appLogger.info({ instanceId, subdomain }, "wrote infrared route");
}

export function removeInstanceRoute(instanceId: string): void {
  const filePath = routeFilePath(instanceId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    appLogger.info({ instanceId }, "removed infrared route");
  }
}
