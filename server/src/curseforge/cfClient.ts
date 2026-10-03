import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../http/errors.js";
import { allowedArtworkUrl } from "../http/artwork.js";
import type { PackPreview } from "../catalog/packPreview.js";
import { htmlToMarkdownLite } from "./htmlToMarkdownLite.js";

/**
 * CurseForge's official API ("Eternal"/CFCore, https://docs.curseforge.com/rest-api/).
 * Unlike FTB's catalog it needs an API key — each self-hoster's own, from
 * https://console.curseforge.com/ — so everything here is unavailable until
 * CF_API_KEY is set.
 *
 * Use is governed by CurseForge's 3rd-party API terms
 * (https://support.curseforge.com/support/solutions/articles/9000207405):
 * the key is the operator's own and must not be shared, and requests
 * identify this app. Those terms also forbid caching API data; responses
 * ARE cached here anyway (in memory, briefly — see CACHE_TTL_MS), a
 * deliberate choice by this project's owner to stay under CurseForge's
 * request limits. The only CurseForge data persisted is what an instance
 * needs to run (its pack and file ids, and the names of files an install is
 * waiting for).
 */
const USER_AGENT = "MinecraftModServerManager (+https://github.com/SykesTheLord/MinecraftModServerManager)";
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;
/** The API refuses index + pageSize beyond this. */
export const MAX_SEARCH_WINDOW = 10_000;

export const CF_SORT_FIELDS = { featured: 1, popularity: 2, updated: 3, name: 4, downloads: 6 } as const;
export type CfSort = keyof typeof CF_SORT_FIELDS;

/** CurseForge's ModLoaderType enum. */
export const CF_LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 } as const;
export type CfLoader = keyof typeof CF_LOADERS;

const modSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  summary: z.string().default(""),
  downloadCount: z.number().default(0),
  dateModified: z.string().optional(),
  allowModDistribution: z.boolean().nullable().optional(),
  logo: z.looseObject({ thumbnailUrl: z.string().nullable().optional(), url: z.string().nullable().optional() }).nullable().optional(),
  authors: z.array(z.looseObject({ name: z.string() })).default([]),
  categories: z.array(z.looseObject({ name: z.string() })).default([]),
  links: z.looseObject({ websiteUrl: z.string().nullable().optional() }).nullable().optional(),
  latestFilesIndexes: z
    .array(z.looseObject({ gameVersion: z.string(), modLoader: z.number().nullable().optional() }))
    .default([]),
  // For the preview.
  screenshots: z
    .array(z.looseObject({ title: z.string().nullable().optional(), thumbnailUrl: z.string(), url: z.string() }))
    .default([]),
  dateReleased: z.string().nullable().optional(),
});

const fileSchema = z.looseObject({
  id: z.number(),
  modId: z.number(),
  displayName: z.string(),
  fileName: z.string(),
  releaseType: z.number(),
  fileDate: z.string(),
  fileLength: z.number().optional(),
  isAvailable: z.boolean().optional(),
  isServerPack: z.boolean().nullable().optional(),
  gameVersions: z.array(z.string()).default([]),
  hashes: z.array(z.looseObject({ value: z.string(), algo: z.number() })).default([]),
});

const paginationSchema = z.looseObject({ index: z.number(), pageSize: z.number(), totalCount: z.number() });

type CfMod = z.infer<typeof modSchema>;
type CfFile = z.infer<typeof fileSchema>;

export interface CfModpackSummary {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloads: number;
  updatedAt: string | null;
  logoUrl: string | null;
  authors: string[];
  categories: string[];
  minecraftVersions: string[];
  loaders: string[];
  websiteUrl: string | null;
}

export interface CfFileSummary {
  id: number;
  displayName: string;
  fileName: string;
  releaseType: "release" | "beta" | "alpha";
  date: string;
  minecraftVersion: string | null;
  loaders: string[];
  sizeBytes: number | null;
}

export function isCurseForgeConfigured(): boolean {
  return Boolean(env.CF_API_KEY);
}

/**
 * In-memory response cache. Identical concurrent calls share one request;
 * failures aren't cached. TTLs follow how often the data actually changes:
 * search results shift constantly, a pack's file list only grows when it's
 * updated (and an admin can force a refresh of it), and a given file's
 * metadata (name, checksums) never changes.
 */
const CACHE_TTL_MS = {
  search: 30 * 60 * 1000,
  modpack: 60 * 60 * 1000,
  fileList: 12 * 60 * 60 * 1000,
  file: 6 * 60 * 60 * 1000,
} as const;
/** A forced refresh still reuses anything fetched this recently, so repeated clicks can't burn the request quota. */
const MIN_REFRESH_AGE_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map<string, { fetchedAt: number; expiresAt: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, refresh = false): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expiresAt > now && (!refresh || now - hit.fetchedAt < MIN_REFRESH_AGE_MS)) {
    return hit.value as Promise<T>;
  }
  cache.delete(key);
  const value = load();
  cache.set(key, { fetchedAt: now, expiresAt: now + ttlMs, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  // Maps iterate in insertion order, so the first key is the oldest entry.
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

/** Sorted, de-duplicated ids, so bulk lookups of the same set share a cache entry. */
const idsKey = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b).join(",");

async function cfFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.CF_API_KEY) throw new HttpError(503, "CurseForge isn't configured: set CF_API_KEY in .env.");
  const res = await fetch(`${env.CF_API_BASE_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "x-api-key": env.CF_API_KEY,
      ...init.headers,
    },
  });
  if (res.status === 403 || res.status === 401) throw new HttpError(502, "CurseForge rejected the API key (CF_API_KEY).");
  if (res.status === 429) {
    throw new HttpError(503, "CurseForge is limiting requests for this API key right now (its usage quota). Try again later.");
  }
  if (res.status === 404) throw new HttpError(404, "Not found on CurseForge.");
  if (!res.ok) throw new HttpError(502, `CurseForge request failed (${res.status}).`);
  return res.json();
}

const RELEASE_TYPES = { 1: "release", 2: "beta", 3: "alpha" } as const;
const LOADER_NAMES: Record<number, string> = { 1: "Forge", 4: "Fabric", 5: "Quilt", 6: "NeoForge" };
const MC_VERSION = /^\d+\.\d+(\.\d+)?$/;

function sortVersionsDesc(versions: Iterable<string>): string[] {
  return [...new Set(versions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function summarizeMod(mod: CfMod): CfModpackSummary {
  return {
    id: mod.id,
    name: mod.name,
    slug: mod.slug,
    summary: mod.summary,
    downloads: mod.downloadCount,
    updatedAt: mod.dateModified ?? null,
    logoUrl: allowedArtworkUrl(mod.logo?.thumbnailUrl ?? mod.logo?.url),
    authors: mod.authors.map((a) => a.name),
    categories: mod.categories.map((c) => c.name),
    minecraftVersions: sortVersionsDesc(mod.latestFilesIndexes.map((i) => i.gameVersion).filter((v) => MC_VERSION.test(v))),
    loaders: [...new Set(mod.latestFilesIndexes.map((i) => LOADER_NAMES[i.modLoader ?? 0]).filter(Boolean))],
    websiteUrl: mod.links?.websiteUrl ?? null,
  };
}

/** A pack file's Minecraft version, from its gameVersions tags (which mix MC versions, loaders and "Server"/"Client"). */
export function minecraftVersionOf(gameVersions: string[]): string | null {
  return sortVersionsDesc(gameVersions.filter((v) => MC_VERSION.test(v)))[0] ?? null;
}

function summarizeFile(file: CfFile): CfFileSummary {
  return {
    id: file.id,
    displayName: file.displayName,
    fileName: file.fileName,
    releaseType: RELEASE_TYPES[file.releaseType as 1 | 2 | 3] ?? "release",
    date: file.fileDate,
    minecraftVersion: minecraftVersionOf(file.gameVersions),
    loaders: file.gameVersions.filter((v) => Object.values(LOADER_NAMES).includes(v)),
    sizeBytes: file.fileLength ?? null,
  };
}

export async function searchCfModpacks(params: {
  query?: string;
  sort: CfSort;
  gameVersion?: string;
  loader?: CfLoader;
  index: number;
  pageSize: number;
}): Promise<{ packs: CfModpackSummary[]; totalCount: number; index: number; pageSize: number }> {
  return cached(`search:${JSON.stringify(params)}`, CACHE_TTL_MS.search, () => searchUncached(params));
}

async function searchUncached(params: Parameters<typeof searchCfModpacks>[0]) {
  const qs = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID),
    classId: String(MODPACKS_CLASS_ID),
    sortField: String(CF_SORT_FIELDS[params.sort]),
    sortOrder: params.sort === "name" ? "asc" : "desc",
    index: String(params.index),
    pageSize: String(params.pageSize),
  });
  if (params.query) qs.set("searchFilter", params.query);
  if (params.gameVersion) qs.set("gameVersion", params.gameVersion);
  if (params.loader) qs.set("modLoaderType", String(CF_LOADERS[params.loader]));
  const body = z
    .looseObject({ data: z.array(modSchema), pagination: paginationSchema })
    .parse(await cfFetch(`/v1/mods/search?${qs}`));
  return {
    packs: body.data.map(summarizeMod),
    // Results past the API's window can't be paged to, so don't promise them.
    totalCount: Math.min(body.pagination.totalCount, MAX_SEARCH_WINDOW),
    index: body.pagination.index,
    pageSize: body.pagination.pageSize,
  };
}

export function getCfModpack(modId: number): Promise<CfModpackSummary> {
  return cached(`mod:${modId}`, CACHE_TTL_MS.modpack, () => getCfModpackUncached(modId));
}

async function getCfModpackUncached(modId: number): Promise<CfModpackSummary> {
  const body = z.looseObject({ data: modSchema }).parse(await cfFetch(`/v1/mods/${modId}`));
  return summarizeMod(body.data);
}

/**
 * A modpack's files, newest first (the most recent 100 — older ones are rarely
 * worth deploying). Reused for 12 hours; `refresh` (an admin's explicit
 * click) fetches it again.
 */
export function listCfModpackFiles(modId: number, options: { refresh?: boolean } = {}): Promise<CfFileSummary[]> {
  return cached(`files:${modId}`, CACHE_TTL_MS.fileList, () => listCfModpackFilesUncached(modId), options.refresh);
}

async function listCfModpackFilesUncached(modId: number): Promise<CfFileSummary[]> {
  const files: CfFile[] = [];
  for (let index = 0; index < 100; index += 50) {
    const body = z
      .looseObject({ data: z.array(fileSchema), pagination: paginationSchema })
      .parse(await cfFetch(`/v1/mods/${modId}/files?index=${index}&pageSize=50`));
    files.push(...body.data);
    if (body.data.length < 50) break;
  }
  return files
    .filter((f) => f.isAvailable !== false && !f.isServerPack)
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
    .map(summarizeFile);
}

export function getCfFile(modId: number, fileId: number): Promise<CfFileSummary> {
  return cached(`file:${modId}:${fileId}`, CACHE_TTL_MS.file, () => getCfFileUncached(modId, fileId));
}

async function getCfFileUncached(modId: number, fileId: number): Promise<CfFileSummary> {
  const body = z.looseObject({ data: fileSchema }).parse(await cfFetch(`/v1/mods/${modId}/files/${fileId}`));
  return summarizeFile(body.data);
}

export interface CfFileDetail {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  sha1: string | null;
  /** Only used when CurseForge lists no SHA-1 for the file. */
  md5: string | null;
}

/** Bulk file lookup — used to describe the files a blocked install needs. */
export async function getCfFiles(fileIds: number[]): Promise<CfFileDetail[]> {
  if (fileIds.length === 0) return [];
  return cached(`bulk-files:${idsKey(fileIds)}`, CACHE_TTL_MS.file, () => getCfFilesUncached(fileIds));
}

async function getCfFilesUncached(fileIds: number[]): Promise<CfFileDetail[]> {
  const body = z
    .looseObject({ data: z.array(fileSchema) })
    .parse(await cfFetch("/v1/mods/files", { method: "POST", body: JSON.stringify({ fileIds }) }));
  return body.data.map((f) => ({
    id: f.id,
    modId: f.modId,
    displayName: f.displayName,
    fileName: f.fileName,
    sha1: f.hashes.find((h) => h.algo === 1)?.value.toLowerCase() ?? null,
    md5: f.hashes.find((h) => h.algo === 2)?.value.toLowerCase() ?? null,
  }));
}

/** Everything the UI shows about one pack before it's deployed: screenshots and the long description too. */
export function getCfModpackPreview(modId: number): Promise<PackPreview> {
  return cached(`preview:${modId}`, CACHE_TTL_MS.modpack, async () => {
    const [modBody, descriptionBody] = await Promise.all([
      cfFetch(`/v1/mods/${modId}`),
      cfFetch(`/v1/mods/${modId}/description`).catch(() => ({ data: "" })),
    ]);
    const mod = z.looseObject({ data: modSchema }).parse(modBody).data;
    const html = z.looseObject({ data: z.string().catch("") }).parse(descriptionBody).data;
    const summary = summarizeMod(mod);
    const screenshots = mod.screenshots.flatMap((s) => {
      const thumbnailUrl = allowedArtworkUrl(s.thumbnailUrl);
      const url = allowedArtworkUrl(s.url);
      return thumbnailUrl && url ? [{ title: s.title ?? "", thumbnailUrl, url }] : [];
    });
    return {
      id: mod.id,
      name: mod.name,
      summary: mod.summary,
      description: htmlToMarkdownLite(html),
      artUrl: summary.logoUrl,
      bannerUrl: screenshots[0]?.url ?? null,
      screenshots,
      authors: summary.authors,
      tags: summary.categories,
      downloads: mod.downloadCount,
      updatedAt: mod.dateModified ?? null,
      releasedAt: mod.dateReleased ?? null,
      websiteUrl: summary.websiteUrl,
      links: [],
    };
  });
}

/** Bulk mod lookup. */
export async function getCfMods(modIds: number[]): Promise<CfModpackSummary[]> {
  if (modIds.length === 0) return [];
  return cached(`bulk-mods:${idsKey(modIds)}`, CACHE_TTL_MS.modpack, () => getCfModsUncached(modIds));
}

async function getCfModsUncached(modIds: number[]): Promise<CfModpackSummary[]> {
  const body = z
    .looseObject({ data: z.array(modSchema) })
    .parse(await cfFetch("/v1/mods", { method: "POST", body: JSON.stringify({ modIds }) }));
  return body.data.map(summarizeMod);
}
