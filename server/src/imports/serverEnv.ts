import { HttpError } from "../http/errors.js";
import type { ServerType } from "./analyze.js";

export interface ImportedServerSettings {
  serverType: ServerType;
  minecraftVersion?: string;
  loaderVersion?: string;
  customJar?: string;
  levelName: string;
}

const LABELS: Record<ServerType, string> = {
  FORGE: "Forge",
  NEOFORGE: "NeoForge",
  FABRIC: "Fabric",
  QUILT: "Quilt",
  PAPER: "Paper",
  VANILLA: "Vanilla",
  CUSTOM: "Custom jar",
};

function required(value: string | undefined, what: string, type: ServerType): string {
  if (!value) throw new HttpError(400, `${LABELS[type]} needs a ${what}.`);
  return value;
}

/**
 * The itzg env that makes the container run an imported server: TYPE plus
 * that platform's version variables (names confirmed against the image's
 * own start-deploy* scripts). Optional loader versions fall back to itzg's
 * "latest" — fine for Fabric/Quilt/Paper, whose loaders are backwards
 * compatible with existing mods; Forge/NeoForge versions are required since
 * a mod set is tied to one.
 */
export function buildImportedServerEnv(settings: ImportedServerSettings, availableJars: string[]): Record<string, string> {
  const { serverType: type, minecraftVersion, loaderVersion } = settings;
  const serverEnv: Record<string, string> = { TYPE: type, LEVEL: settings.levelName };

  if (type === "CUSTOM") {
    const jar = required(settings.customJar, "server jar", type);
    if (!availableJars.includes(jar)) throw new HttpError(400, `"${jar}" isn't one of the imported server's jars.`);
    serverEnv.CUSTOM_SERVER = `/data/${jar}`;
    if (minecraftVersion) serverEnv.VERSION = minecraftVersion;
    return serverEnv;
  }

  serverEnv.VERSION = required(minecraftVersion, "Minecraft version", type);
  switch (type) {
    case "FORGE":
      serverEnv.FORGE_VERSION = required(loaderVersion, "Forge version", type);
      break;
    case "NEOFORGE":
      serverEnv.NEOFORGE_VERSION = required(loaderVersion, "NeoForge version", type);
      break;
    case "FABRIC":
      if (loaderVersion) serverEnv.FABRIC_LOADER_VERSION = loaderVersion;
      break;
    case "QUILT":
      if (loaderVersion) serverEnv.QUILT_LOADER_VERSION = loaderVersion;
      break;
    case "PAPER":
      if (loaderVersion) serverEnv.PAPER_BUILD = loaderVersion;
      break;
  }
  return serverEnv;
}

/** Shown where FTB instances show their pack name, e.g. "Imported: Forge 1.20.1 (47.2.0)". */
export function importedServerLabel(settings: ImportedServerSettings): string {
  if (settings.serverType === "CUSTOM") return `Imported: ${settings.customJar}`;
  const loader = settings.loaderVersion ? ` (${settings.loaderVersion})` : "";
  return `Imported: ${LABELS[settings.serverType]} ${settings.minecraftVersion}${loader}`;
}
