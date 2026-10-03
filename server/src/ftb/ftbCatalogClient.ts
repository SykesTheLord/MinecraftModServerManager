import { z } from "zod";
import { allowedArtworkUrl } from "../http/artwork.js";
import type { PackPreview } from "../catalog/packPreview.js";

/**
 * FTB's public modpack catalog API — the same backing data source used by the
 * FTB App and by https://feed-the-beast.com/modpacks/server-files/linux to
 * list modpacks and their Linux server files. It is unauthenticated (no API
 * key), unlike CurseForge's CFCore API.
 *
 * FTB moved this API to api.feed-the-beast.com/v1/modpacks; the legacy
 * api.modpacks.ch host still answers but stopped receiving new versions in
 * August 2024 (FTB NeoTech ends at 1.7.0 there, 1.13.0 here) and rejects
 * newer version ids. Version ids from before the move are the same on both,
 * so existing instances are unaffected. itzg's FTBA installer uses this host
 * too, so any version listed here is one it can install.
 *
 * Endpoint shapes confirmed live: GET /public/modpack/all returns {packs:
 * number[]} (every public pack id); GET /public/modpack/{id} returns {id,
 * name, synopsis, art, tags, installs, updated, versions: [{id, name, type,
 * updated, specs: {recommended}, targets: [{name, version, type}]}]}. It's
 * community-documented rather than officially versioned by FTB, so it could
 * change without notice — worth a periodic sanity check.
 */
const FTB_API_BASE = "https://api.feed-the-beast.com/v1/modpacks/public";
// Some clients' default user agents get a 403 here; identify ourselves rather than rely on fetch's default.
const USER_AGENT = "MinecraftModServerManager (+https://github.com/SykesTheLord/MinecraftModServerManager)";

const targetSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  type: z.string().optional(),
});

const modpackVersionSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
  updated: z.number().optional(),
  private: z.boolean().optional(),
  specs: z.looseObject({ recommended: z.number().optional(), minimum: z.number().optional() }).nullable().optional(),
  targets: z.array(targetSchema).default([]),
});

const modpackDetailSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  synopsis: z.string().optional().default(""),
  installs: z.number().optional().default(0),
  updated: z.number().optional(),
  featured: z.boolean().optional().default(false),
  private: z.boolean().optional(),
  art: z.array(z.looseObject({ type: z.string(), url: z.string() })).default([]),
  tags: z.array(z.looseObject({ name: z.string() })).default([]),
  versions: z.array(modpackVersionSchema).default([]),
  // For the preview (Markdown; see catalog/packPreview.ts).
  description: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  released: z.number().nullable().optional(),
  authors: z.array(z.looseObject({ name: z.string() })).default([]),
  links: z.array(z.looseObject({ name: z.string().nullable().optional(), link: z.string() })).default([]),
});

const packIdListSchema = z.looseObject({
  packs: z.array(z.number()).default([]),
});

const versionDetailSchema = z.looseObject({
  id: z.number(),
  targets: z.array(targetSchema).default([]),
});

export interface ModpackSummary {
  id: number;
  name: string;
  synopsis: string;
  installs: number;
  /** Unix seconds. */
  updatedAt: number | null;
  featured: boolean;
  artUrl: string | null;
  tags: string[];
  /** Of the newest version. */
  minecraftVersion: string | null;
  loader: string | null;
}

export interface ModpackVersionSummary {
  id: number;
  name: string;
  type: string;
  /** Unix seconds. */
  updatedAt: number | null;
  minecraftVersion: string | null;
  loader: string | null;
  javaVersion: string | null;
  /** FTB's own recommendation for this version, MB. */
  recommendedMemoryMb: number | null;
}

async function fetchJson<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`FTB catalog request failed (${res.status}): ${url}`);
  }
  return schema.parse(await res.json());
}

type ModpackDetail = z.infer<typeof modpackDetailSchema>;

const LOADER_NAMES: Record<string, string> = { forge: "Forge", neoforge: "NeoForge", fabric: "Fabric", quilt: "Quilt" };

function summarizeVersion(v: ModpackDetail["versions"][number]): ModpackVersionSummary {
  const target = (type: string) => v.targets.find((t) => t.type === type || t.name === type);
  const loader = v.targets.find((t) => t.type === "modloader");
  return {
    id: v.id,
    name: v.name,
    type: v.type ?? "release",
    updatedAt: v.updated ?? null,
    minecraftVersion: target("minecraft")?.version ?? null,
    loader: loader ? `${LOADER_NAMES[loader.name] ?? loader.name} ${loader.version}` : null,
    javaVersion: target("java")?.version ?? null,
    recommendedMemoryMb: v.specs?.recommended ?? null,
  };
}

function publicVersions(pack: ModpackDetail): ModpackVersionSummary[] {
  return pack.versions
    .filter((v) => !v.private)
    .map(summarizeVersion)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.id - a.id);
}

function summarizePack(pack: ModpackDetail): ModpackSummary {
  const newest = publicVersions(pack)[0];
  const art = pack.art.find((a) => a.type === "square") ?? pack.art.find((a) => a.type === "logo");
  return {
    id: pack.id,
    name: pack.name,
    synopsis: pack.synopsis.trim(),
    installs: pack.installs,
    updatedAt: pack.updated ?? null,
    featured: pack.featured,
    artUrl: allowedArtworkUrl(art?.url),
    tags: pack.tags.map((t) => t.name),
    minecraftVersion: newest?.minecraftVersion ?? null,
    loader: newest?.loader?.split(" ")[0] ?? null,
  };
}

async function getModpackDetail(modpackId: number): Promise<ModpackDetail> {
  return fetchJson(`${FTB_API_BASE}/modpack/${modpackId}`, modpackDetailSchema);
}

/**
 * The whole FTB catalog. It's small (~100 packs) but the API only lists ids,
 * so every pack's details are fetched (a few at a time) and the result is
 * cached for an hour; concurrent callers share one refresh.
 */
const CATALOG_TTL_MS = 60 * 60 * 1000;
const DETAIL_CONCURRENCY = 8;
let catalog: { packs: ModpackSummary[]; fetchedAt: number } | null = null;
let refreshing: Promise<ModpackSummary[]> | null = null;

async function fetchCatalog(): Promise<ModpackSummary[]> {
  const { packs: ids } = await fetchJson(`${FTB_API_BASE}/modpack/all`, packIdListSchema);
  const packs: ModpackSummary[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: DETAIL_CONCURRENCY }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const detail = await getModpackDetail(id).catch(() => null);
        if (detail && !detail.private && publicVersions(detail).length > 0) packs.push(summarizePack(detail));
      }
    })
  );
  if (packs.length === 0) throw new Error("The FTB catalog returned no usable modpacks.");
  return packs.sort((a, b) => b.installs - a.installs);
}

export async function listAllModpacks(): Promise<ModpackSummary[]> {
  if (catalog && Date.now() - catalog.fetchedAt < CATALOG_TTL_MS) return catalog.packs;
  refreshing ??= fetchCatalog()
    .then((packs) => {
      catalog = { packs, fetchedAt: Date.now() };
      return packs;
    })
    .catch((err) => {
      if (catalog) return catalog.packs; // stale beats nothing when FTB has a blip
      throw err;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const isoFromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/** Everything the UI shows about one pack before it's deployed. */
export async function getModpackPreview(modpackId: number): Promise<PackPreview> {
  const pack = await getModpackDetail(modpackId);
  const art = (type: string) => allowedArtworkUrl(pack.art.find((a) => a.type === type)?.url);
  return {
    id: pack.id,
    name: pack.name,
    summary: pack.synopsis.trim(),
    description: (pack.description ?? "").trim(),
    artUrl: art("square") ?? art("logo"),
    bannerUrl: art("splash") ?? art("background"),
    screenshots: [],
    authors: pack.authors.map((a) => a.name),
    tags: pack.tags.map((t) => t.name),
    downloads: pack.installs,
    updatedAt: isoFromUnix(publicVersions(pack)[0]?.updatedAt ?? pack.updated),
    releasedAt: isoFromUnix(pack.released),
    websiteUrl: pack.slug ? `https://www.feed-the-beast.com/modpacks/${pack.id}-${pack.slug}` : null,
    links: pack.links
      .filter((l) => /^https:\/\//.test(l.link))
      .map((l) => ({ name: l.name || new URL(l.link).hostname, url: l.link })),
  };
}

export async function listModpackVersions(modpackId: number): Promise<ModpackVersionSummary[]> {
  return publicVersions(await getModpackDetail(modpackId));
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
