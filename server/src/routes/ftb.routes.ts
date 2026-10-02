import { Router } from "express";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import { HttpError } from "../http/errors.js";
import { listAllModpacks, listModpackVersions } from "../ftb/ftbCatalogClient.js";

export const ftbRouter = Router();
ftbRouter.use(requireAuth, requireSuperadmin);

/** The whole (small) FTB catalog — the UI filters and sorts it client-side. */
ftbRouter.get("/modpacks", async (_req, res) => {
  try {
    res.json(await listAllModpacks());
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : "FTB catalog request failed.");
  }
});

ftbRouter.get("/modpacks/:id/versions", async (req, res) => {
  const modpackId = Number(req.params.id);
  if (!Number.isInteger(modpackId)) throw new HttpError(400, "Invalid modpack id.");
  try {
    res.json(await listModpackVersions(modpackId));
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : "FTB catalog lookup failed.");
  }
});
