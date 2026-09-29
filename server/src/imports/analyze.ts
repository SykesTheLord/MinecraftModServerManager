import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { javaMajorForMinecraftVersion, KNOWN_JAVA_VERSIONS } from "../docker/javaImage.js";

/**
 * Server platforms an imported server can run as. Each maps to an itzg
 * `TYPE` (see imports/serverEnv.ts); itzg (re)installs that loader version
 * itself on first boot, next to the copied mods/configs/world — the native
 * machine's own launcher scripts are never used. CUSTOM runs a jar from the
 * import as-is, for anything not recognized.
 */
export const SERVER_TYPES = ["FORGE", "NEOFORGE", "FABRIC", "QUILT", "PAPER", "VANILLA", "CUSTOM"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export interface ImportAnalysis {
  serverType: ServerType;
  minecraftVersion: string | null;
  loaderVersion: string | null;
  customJar: string | null;
  /** Java major the image tag would be picked for (null: the MC_IMAGE default). */
  javaVersion: number | null;
  javaVersions: readonly number[];
  /** Heap size from the native launch config (-Xmx), if one was found. */
  memoryMb: number | null;
  levelName: string;
  worldFound: boolean;
  motd: string | null;
  /** Top-level jars, the candidates for a CUSTOM server jar. */
  jars: string[];
  modCount: number;
  totalBytes: number;
  warnings: string[];
}

/** Directories a native server accumulates that aren't worth carrying over. */
export const DISPOSABLE_DIRS = ["logs", "crash-reports"];

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function files(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (cmp !== 0) return cmp;
    } else if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}

function highest(versions: string[]): string | null {
  return versions.length ? [...versions].sort(compareVersions).at(-1)! : null;
}

/**
 * The directory the server actually lives in. Archives are often made of the
 * server's parent directory (`server/…`) rather than its contents, so this
 * looks a few levels down for server.properties, and otherwise descends
 * through single-directory wrappers.
 */
export function findServerRoot(dir: string): string {
  let level = [dir];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const hit = level.find((d) => fs.existsSync(path.join(d, "server.properties")));
    if (hit) return hit;
    level = level.flatMap((d) => subdirs(d).map((name) => path.join(d, name)));
  }

  let root = dir;
  for (;;) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) return root;
    root = path.join(root, entries[0].name);
  }
}

export function readServerProperties(root: string): Map<string, string> {
  const props = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, "server.properties"), "utf8");
  } catch {
    return props;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return props;
}

/**
 * Rewrites the few server.properties values that only made sense on the
 * native host: the container must listen on 25565 on all interfaces, since
 * that's where Infrared proxies to (a native server on another port, or bound
 * to the old host's IP, would be unreachable). Everything else — whitelist,
 * MOTD, gamemode, … — is kept exactly as the admin had it.
 */
export function prepareServerProperties(root: string): void {
  const file = path.join(root, "server.properties");
  if (!fs.existsSync(file)) return;
  const overrides = new Map([
    ["server-port", "25565"],
    ["server-ip", ""],
  ]);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const seen = new Set<string>();
  const rewritten = lines.map((line) => {
    const eq = line.indexOf("=");
    const key = eq > 0 && !line.startsWith("#") ? line.slice(0, eq).trim() : null;
    if (key && overrides.has(key)) {
      seen.add(key);
      return `${key}=${overrides.get(key)}`;
    }
    return line;
  });
  for (const [key, value] of overrides) if (!seen.has(key)) rewritten.push(`${key}=${value}`);
  fs.writeFileSync(file, rewritten.join("\n"));
}

/** Lists a jar's entries and reads one small entry (null if absent or not a zip). */
function readJarEntries(jar: string, wanted: string): Promise<{ names: string[]; content: string | null }> {
  return new Promise((resolve) => {
    const names: string[] = [];
    let content: string | null = null;
    yauzl.open(jar, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return resolve({ names, content });
      zip.on("error", () => resolve({ names, content }));
      zip.on("end", () => resolve({ names, content }));
      zip.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        if (entry.fileName !== wanted || entry.uncompressedSize > 64 * 1024) return zip.readEntry();
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return zip.readEntry();
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", () => zip.readEntry());
          stream.on("end", () => {
            content = Buffer.concat(chunks).toString("utf8");
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

interface Detection {
  serverType: ServerType;
  minecraftVersion: string | null;
  loaderVersion: string | null;
  customJar: string | null;
}

/** NeoForge 20.4.x → MC 1.20.4, 21.0.x → 1.21, 21.1.x → 1.21.1; year-based 26.1.x → 26.1. */
function minecraftVersionForNeoForge(version: string): string | null {
  const [major, minor] = version.split(".").map(Number);
  if (Number.isNaN(major) || Number.isNaN(minor)) return null;
  if (major >= 26) return `${major}.${minor}`;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

async function detectServerType(root: string, jars: string[]): Promise<Detection> {
  const libs = path.join(root, "libraries");
  // Modern Forge/NeoForge/Fabric installs all keep the vanilla server here.
  const libMinecraft = highest(subdirs(path.join(libs, "net/minecraft/server")).map((v) => v.split("-")[0]));
  const intermediary = highest(subdirs(path.join(libs, "net/fabricmc/intermediary")));
  const none = { loaderVersion: null, customJar: null };

  const neoForge = highest(subdirs(path.join(libs, "net/neoforged/neoforge")));
  if (neoForge) {
    return { serverType: "NEOFORGE", minecraftVersion: libMinecraft ?? minecraftVersionForNeoForge(neoForge), loaderVersion: neoForge, customJar: null };
  }
  // NeoForge's first release (1.20.1) still used Forge's "<mc>-<version>" layout.
  const neoForgeLegacy = highest(subdirs(path.join(libs, "net/neoforged/forge")));
  if (neoForgeLegacy?.includes("-")) {
    const [mc, version] = [neoForgeLegacy.slice(0, neoForgeLegacy.indexOf("-")), neoForgeLegacy.slice(neoForgeLegacy.indexOf("-") + 1)];
    return { serverType: "NEOFORGE", minecraftVersion: mc, loaderVersion: version, customJar: null };
  }

  const forge = highest(subdirs(path.join(libs, "net/minecraftforge/forge")).filter((v) => v.includes("-")));
  if (forge) {
    const dash = forge.indexOf("-");
    return { serverType: "FORGE", minecraftVersion: forge.slice(0, dash), loaderVersion: forge.slice(dash + 1), customJar: null };
  }
  // Pre-1.17 Forge: forge-1.12.2-14.23.5.2860.jar, forge-1.7.10-10.13.4.1614-1.7.10-universal.jar
  for (const jar of jars) {
    const match = jar.match(/^forge-(\d+\.\d+(?:\.\d+)?)-(\d+(?:\.\d+)+)(?:-[\d.]+)?(?:-universal)?\.jar$/);
    if (match) return { serverType: "FORGE", minecraftVersion: match[1], loaderVersion: match[2], customJar: null };
  }

  const quilt = highest(subdirs(path.join(libs, "org/quiltmc/quilt-loader")));
  if (quilt) return { serverType: "QUILT", minecraftVersion: intermediary ?? libMinecraft, loaderVersion: quilt, customJar: null };

  const fabric = highest(subdirs(path.join(libs, "net/fabricmc/fabric-loader")));
  for (const jar of jars) {
    const match = jar.match(/^fabric-server-mc\.(.+)-loader\.(.+)-launcher\..+\.jar$/);
    if (match) return { serverType: "FABRIC", minecraftVersion: match[1], loaderVersion: match[2], customJar: null };
  }
  if (fabric || jars.includes("fabric-server-launch.jar")) {
    const fabricMc = highest(files(path.join(root, ".fabric/server")).map((f) => f.match(/^(.+)-server\.jar$/)?.[1] ?? "").filter(Boolean));
    return { serverType: "FABRIC", minecraftVersion: intermediary ?? fabricMc ?? libMinecraft, loaderVersion: fabric, customJar: null };
  }

  for (const jar of jars) {
    const paper = jar.match(/^paper-(\d+\.\d+(?:\.\d+)?)-(\d+)\.jar$/);
    if (paper) return { serverType: "PAPER", minecraftVersion: paper[1], loaderVersion: paper[2], customJar: null };
    const vanilla = jar.match(/^minecraft_server\.(.+)\.jar$/);
    if (vanilla) return { serverType: "VANILLA", minecraftVersion: vanilla[1], ...none };
  }

  // A generically named jar (server.jar): look inside. Vanilla jars since
  // 1.14 carry version.json; Paper's launcher ships its own classes.
  for (const jar of jars) {
    const { names, content } = await readJarEntries(path.join(root, jar), "version.json");
    if (!content) continue;
    let id: string | null = null;
    try {
      id = (JSON.parse(content) as { id?: string }).id ?? null;
    } catch {
      continue;
    }
    const isPaper = names.some((n) => n.startsWith("io/papermc/"));
    return { serverType: isPaper ? "PAPER" : "VANILLA", minecraftVersion: id, ...none };
  }

  return { serverType: "CUSTOM", minecraftVersion: libMinecraft ?? intermediary, loaderVersion: null, customJar: jars[0] ?? null };
}

/** The largest -Xmx in the native launch config (start scripts, Forge's user_jvm_args.txt). */
function detectHeapMb(root: string): number | null {
  let best: number | null = null;
  for (const name of files(root)) {
    if (!/\.(sh|bat|cmd|txt|conf|cfg)$/i.test(name) && name !== "start") continue;
    const file = path.join(root, name);
    if (fs.statSync(file).size > 64 * 1024) continue;
    for (const match of fs.readFileSync(file, "utf8").matchAll(/-Xmx(\d+)([gGmMkK]?)\b/g)) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      const mb = unit === "g" ? value * 1024 : unit === "m" ? value : unit === "k" ? value / 1024 : value / 1024 / 1024;
      if (mb >= 512 && (best === null || mb > best)) best = Math.round(mb);
    }
  }
  return best;
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

export async function analyzeServer(root: string): Promise<ImportAnalysis> {
  const warnings: string[] = [];
  const props = readServerProperties(root);
  if (!fs.existsSync(path.join(root, "server.properties"))) {
    warnings.push("No server.properties found — is this the server's directory? Defaults will be generated on first boot.");
  }

  const jars = files(root).filter((f) => f.endsWith(".jar")).sort();
  const detection = await detectServerType(root, jars);
  if (detection.serverType === "CUSTOM") {
    warnings.push("Couldn't identify the server platform. Pick it below, or choose the jar to run as a custom server.");
  }
  if (!detection.minecraftVersion && detection.serverType !== "CUSTOM") {
    warnings.push("Couldn't determine the Minecraft version — enter it below.");
  }

  // Only a world-relative path is meaningful inside the container.
  const rawLevel = props.get("level-name") || "world";
  const levelName = /^[^/\\]+$/.test(rawLevel) && rawLevel !== ".." ? rawLevel : "world";
  const worldFound = fs.existsSync(path.join(root, levelName, "level.dat"));
  if (!worldFound) warnings.push(`No world found at "${levelName}/" — a new world will be generated on first boot.`);

  return {
    ...detection,
    javaVersion: javaMajorForMinecraftVersion(detection.minecraftVersion),
    javaVersions: KNOWN_JAVA_VERSIONS,
    memoryMb: detectHeapMb(root),
    levelName,
    worldFound,
    motd: props.get("motd") ?? null,
    jars,
    modCount: files(path.join(root, "mods")).filter((f) => f.endsWith(".jar")).length,
    totalBytes: directorySize(root),
    warnings,
  };
}
