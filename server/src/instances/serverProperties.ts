import crypto from "node:crypto";
import { docker } from "../docker/dockerClient.js";
import { readContainerFile, writeContainerFile } from "../docker/containerFiles.js";
import type { InstanceRow } from "../db/repositories/instanceRepo.js";
import { HttpError } from "../http/errors.js";

/**
 * Viewing and editing an instance's server.properties.
 *
 * The file lives in the instance's volume and is read/written through the
 * Docker archive API, so this works whether the server is running or not
 * (Minecraft only reads it at startup — changes apply on the next restart).
 *
 * Some keys aren't the admin's to change, because something else owns them:
 * itzg rewrites a property on every start only when its env var is set, and
 * the manager sets the RCON ones (the console depends on them) and, for
 * imported/CurseForge servers, LEVEL. Infrared proxies every subdomain to
 * port 25565 on all interfaces, so server-port/server-ip must stay put.
 * Those are shown read-only with the reason instead of silently reverting.
 *
 * Values are kept exactly as written in the file (Java properties escapes
 * like § included) so a round trip never changes what the admin didn't
 * touch; comments and ordering are preserved.
 */

const FILE = "/data/server.properties";
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_VALUE_LENGTH = 4096;

export interface PropertyEntry {
  key: string;
  value: string;
  /** Why it can't be edited, if it can't. */
  managed: string | null;
}

export interface ServerPropertiesView {
  properties: PropertyEntry[];
  /** Changes since this was read are refused (Minecraft rewrites the file at startup too). */
  revision: string;
}

function managedKeys(instance: InstanceRow): Map<string, string> {
  const managed = new Map([
    ["server-port", "Must stay 25565 — that's where the shared proxy sends players."],
    ["server-ip", "Must stay empty (all interfaces) so the shared proxy can reach the server."],
    ["enable-rcon", "Managed: the console sends commands over RCON."],
    ["rcon.port", "Managed: the console sends commands over RCON."],
    ["rcon.password", "Managed: a per-server secret, set on every start."],
  ]);
  const serverEnv = instance.server_env ? (JSON.parse(instance.server_env) as Record<string, string>) : {};
  if (serverEnv.LEVEL) managed.set("level-name", `Set on every start from the server's configuration (${serverEnv.LEVEL}).`);
  return managed;
}

/** Splits `key=value` / `key:value` / `key value` the way java.util.Properties does (unescaped separators only). */
function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return null;
  let i = 0;
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "=" || c === ":" || c === " " || c === "\t") break;
    i++;
  }
  const key = trimmed.slice(0, i);
  let rest = trimmed.slice(i).replace(/^[ \t]*/, "");
  if (rest.startsWith("=") || rest.startsWith(":")) rest = rest.slice(1).replace(/^[ \t]*/, "");
  return { key, value: rest };
}

function revisionOf(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function containerFor(instance: InstanceRow) {
  if (!instance.container_id) {
    throw new HttpError(409, "This server hasn't been created yet, so it has no server.properties.");
  }
  return docker.getContainer(instance.container_id);
}

export async function readServerProperties(instance: InstanceRow): Promise<ServerPropertiesView> {
  const text = await readContainerFile(await containerFor(instance), FILE);
  if (text === null) {
    throw new HttpError(404, "server.properties doesn't exist yet — Minecraft creates it the first time the server starts.");
  }
  const managed = managedKeys(instance);
  const properties: PropertyEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    properties.push({
      key: parsed.key,
      value: parsed.key === "rcon.password" ? "••••••••" : parsed.value,
      managed: managed.get(parsed.key) ?? null,
    });
  }
  return { properties, revision: revisionOf(text) };
}

/**
 * Replaces the editable properties with `desired` (every editable key the
 * admin wants to keep — omitted ones are removed). Managed keys keep their
 * current values whatever is sent.
 */
export async function writeServerProperties(
  instance: InstanceRow,
  desired: Record<string, string>,
  revision: string
): Promise<ServerPropertiesView> {
  const container = await containerFor(instance);
  const text = await readContainerFile(container, FILE);
  if (text === null) throw new HttpError(404, "server.properties doesn't exist yet.");
  if (revisionOf(text) !== revision) {
    throw new HttpError(409, "server.properties changed since you opened it (the server may have rewritten it). Reload and try again.");
  }

  const managed = managedKeys(instance);
  for (const [key, value] of Object.entries(desired)) {
    if (!KEY.test(key)) throw new HttpError(400, `"${key}" isn't a valid property name.`);
    if (value.length > MAX_VALUE_LENGTH || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new HttpError(400, `The value of "${key}" contains line breaks or control characters, or is too long.`);
    }
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) {
      lines.push(line);
      continue;
    }
    seen.add(parsed.key);
    if (managed.has(parsed.key)) lines.push(line);
    else if (parsed.key in desired) {
      // Keep the line untouched if its value didn't change (preserves its exact formatting).
      lines.push(desired[parsed.key] === parsed.value ? line : `${parsed.key}=${desired[parsed.key]}`);
    }
    // else: removed by the admin
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(desired)) {
    if (!seen.has(key) && !managed.has(key)) lines.push(`${key}=${value}`);
  }
  await writeContainerFile(container, "/data", "server.properties", `${lines.join("\n")}\n`);
  return readServerProperties(instance);
}
