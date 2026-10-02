import { Router } from "express";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import { settingsRepo } from "../db/repositories/settingsRepo.js";
import { env } from "../config/env.js";
import { routeParam } from "../http/errors.js";
import { APP_VERSION } from "../config/version.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/** Read-only for any authenticated user — the wizard needs it to suggest full subdomains. */
settingsRouter.get("/base-domain", (_req, res) => {
  res.json({ baseDomain: env.BASE_DOMAIN });
});

/** Which build of the manager is running (scripts/update.sh moves it forward). */
settingsRouter.get("/version", (_req, res) => {
  res.json({ version: APP_VERSION, commit: env.APP_COMMIT });
});

settingsRouter.get("/:key", requireSuperadmin, (req, res) => {
  const value = settingsRepo.get(routeParam(req, "key"));
  if (value === undefined) {
    res.status(404).json({ error: "Setting not found." });
    return;
  }
  res.json({ key: routeParam(req, "key"), value });
});

settingsRouter.put("/:key", requireSuperadmin, (req, res) => {
  const value = String(req.body?.value ?? "");
  settingsRepo.set(routeParam(req, "key"), value);
  res.json({ ok: true });
});
