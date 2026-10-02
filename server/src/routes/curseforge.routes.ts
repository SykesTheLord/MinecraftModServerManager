import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import { HttpError, routeParam } from "../http/errors.js";
import {
  CF_LOADERS,
  CF_SORT_FIELDS,
  MAX_SEARCH_WINDOW,
  isCurseForgeConfigured,
  listCfModpackFiles,
  searchCfModpacks,
  type CfLoader,
  type CfSort,
} from "../curseforge/cfClient.js";

/** Browsing CurseForge's modpack catalog (superadmin-only, like creating instances). */
export const curseforgeRouter = Router();
curseforgeRouter.use(requireAuth, requireSuperadmin);

curseforgeRouter.get("/status", (_req, res) => {
  res.json({ configured: isCurseForgeConfigured() });
});

const PAGE_SIZE = 40;

const searchSchema = z.object({
  query: z.string().trim().max(100).optional(),
  sort: z.enum(Object.keys(CF_SORT_FIELDS) as [CfSort, ...CfSort[]]).default("popularity"),
  gameVersion: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/)
    .optional(),
  loader: z.enum(Object.keys(CF_LOADERS) as [CfLoader, ...CfLoader[]]).optional(),
  index: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_SEARCH_WINDOW - PAGE_SIZE)
    .default(0),
});

curseforgeRouter.get("/modpacks", async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  res.json(await searchCfModpacks({ ...parsed.data, query: parsed.data.query || undefined, pageSize: PAGE_SIZE }));
});

curseforgeRouter.get("/modpacks/:id/files", async (req, res) => {
  const modId = Number(routeParam(req, "id"));
  if (!Number.isInteger(modId)) throw new HttpError(400, "Invalid modpack id.");
  // `?refresh=1`: the admin clicked force refresh (otherwise reused for 12 hours).
  res.json(await listCfModpackFiles(modId, { refresh: req.query.refresh === "1" }));
});
