import { env } from "../config/env.js";

/**
 * itzg/minecraft-server selects its bundled JVM by *image tag*, not an env
 * var — confirmed against
 * https://docker-minecraft-server.readthedocs.io/en/latest/versions/java/ ,
 * and the hard way, by actually deploying two real FTB packs in this
 * environment: a 1.7.10 Forge pack and a 1.16.4 Forge pack both crash-looped
 * on the "stable" (Java 25) tag with exactly the errors that page documents
 * as "you need Java 8" (a ClassCastException from Forge's legacy launch
 * wrapper, and an IllegalAccessError from a modlauncher too old for a modern
 * JDK's module system respectively). Forge below 1.18 categorically requires
 * Java 8. This resolver picks a tag from the modpack version's own declared
 * Java target (FTB's API exposes this — see ftbCatalogClient.getModpackJavaMajorVersion)
 * instead of always using one fixed tag for every modpack.
 */
export const KNOWN_JAVA_VERSIONS = [8, 11, 16, 17, 21, 25] as const;
const KNOWN_JAVA_TAGS = new Set<number>(KNOWN_JAVA_VERSIONS);

/** MC_IMAGE without its tag, keeping any registry prefix (including one with a :port). */
function imageRepository(image: string): string {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  return lastColon > lastSlash ? image.slice(0, lastColon) : image;
}

export function resolveMinecraftImage(javaMajor: number | null): string {
  if (javaMajor !== null && KNOWN_JAVA_TAGS.has(javaMajor)) {
    return `${imageRepository(env.MC_IMAGE)}:java${javaMajor}`;
  }

  // Unknown/newer-than-anything-tagged: fall back to the tracked default,
  // which itzg's docs say always carries the newest Java a current Minecraft
  // release needs — the safer default for packs we can't classify.
  return env.MC_IMAGE;
}

/**
 * The Java major a Minecraft version needs, for servers that don't come with
 * a declared Java target (imported ones — FTB packs declare their own).
 * Mojang's minimums: 1.17 → 16 (17 runs it too, and is the better-supported
 * tag), 1.18 → 17, 1.20.5 → 21; year-based versions (26.1+) → 25. Everything up to 1.16 gets 8 rather than "anything ≥ 8":
 * Forge on those versions crash-loops on newer JVMs (see above).
 */
export function javaMajorForMinecraftVersion(version: string | null | undefined): number | null {
  const match = version?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (major >= 26) return 25;
  if (major !== 1) return null;
  if (minor <= 16) return 8;
  if (minor < 20 || (minor === 20 && patch < 5)) return 17;
  return 21;
}
