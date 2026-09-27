import { z } from "zod";

/**
 * FTB's public modpack catalog API — the same backing data source used by the
 * FTB App and by https://feed-the-beast.com/modpacks/server-files/linux to
 * list modpacks and their Linux server files. It is unauthenticated (no API
 * key), unlike CurseForge's CFCore API.
 *
 * This endpoint shape was confirmed live during implementation (GET
 * /public/modpack/search/{limit}?term=... returns {packs: number[]}; GET
 * /public/modpack/{id} returns {id, name, synopsis, versions: [{id, name,
 * type}, ...]}) but is community-documented rather than officially versioned
 * by FTB, so it could change without notice — worth a periodic sanity check.
 */
const FTB_API_BASE = "https://api.modpacks.ch/public";

const modpackVersionSummarySchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
});

const modpackDetailSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  synopsis: z.string().optional().default(""),
  versions: z.array(modpackVersionSummarySchema).default([]),
});

const searchResultSchema = z.looseObject({
  packs: z.array(z.number()).default([]),
});

const targetSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  type: z.string().optional(),
});

const versionDetailSchema = z.looseObject({
  id: z.number(),
  targets: z.array(targetSchema).default([]),
});

export interface ModpackSummary {
  id: number;
  name: string;
  synopsis: string;
}

export interface ModpackVersionSummary {
  id: number;
  name: string;
}

async function fetchJson<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FTB catalog request failed (${res.status}): ${url}`);
  }
  return schema.parse(await res.json());
}

export async function searchModpacks(term: string, limit = 20): Promise<ModpackSummary[]> {
  const search = await fetchJson(
    `${FTB_API_BASE}/modpack/search/${limit}?term=${encodeURIComponent(term)}`,
    searchResultSchema
  );

  const details = await Promise.all(
    search.packs.map((id) => getModpack(id).catch(() => undefined))
  );

  return details.filter((d): d is ModpackSummary & { versions: ModpackVersionSummary[] } => Boolean(d));
}

export async function getModpack(modpackId: number): Promise<ModpackSummary & { versions: ModpackVersionSummary[] }> {
  const modpack = await fetchJson(`${FTB_API_BASE}/modpack/${modpackId}`, modpackDetailSchema);
  return {
    id: modpack.id,
    name: modpack.name,
    synopsis: modpack.synopsis,
    versions: modpack.versions.map((v) => ({ id: v.id, name: v.name })),
  };
}

export async function listModpackVersions(modpackId: number): Promise<ModpackVersionSummary[]> {
  const modpack = await getModpack(modpackId);
  return modpack.versions;
}

/**
 * Every version declares its own Forge/Minecraft/Java target trio (confirmed
 * live via GET /public/modpack/{modpackId}/{versionId}). The Java major
 * version matters a lot in practice: it's what determines which
 * itzg/minecraft-server image tag can actually boot this pack — see
 * docker/javaImage.ts.
 */
export async function getModpackJavaMajorVersion(modpackId: number, versionId: number): Promise<number | null> {
  const detail = await fetchJson(`${FTB_API_BASE}/modpack/${modpackId}/${versionId}`, versionDetailSchema);
  const javaTarget = detail.targets.find((t) => t.name === "java");
  if (!javaTarget) return null;

  const major = Number.parseInt(javaTarget.version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : null;
}
