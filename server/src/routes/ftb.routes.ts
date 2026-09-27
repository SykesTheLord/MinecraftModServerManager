import { Router } from "express";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import { getModpack, searchModpacks } from "../ftb/ftbCatalogClient.js";

export const ftbRouter = Router();
ftbRouter.use(requireAuth, requireSuperadmin);

ftbRouter.get("/modpacks", async (req, res) => {
  const term = String(req.query.query ?? "").trim();
  if (!term) {
    res.status(400).json({ error: "query parameter is required." });
    return;
  }
  try {
    res.json(await searchModpacks(term));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "FTB catalog search failed." });
  }
});

ftbRouter.get("/modpacks/:id/versions", async (req, res) => {
  const modpackId = Number(req.params.id);
  if (!Number.isInteger(modpackId)) {
    res.status(400).json({ error: "Invalid modpack id." });
    return;
  }
  try {
    const modpack = await getModpack(modpackId);
    res.json(modpack.versions);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "FTB catalog lookup failed." });
  }
});
