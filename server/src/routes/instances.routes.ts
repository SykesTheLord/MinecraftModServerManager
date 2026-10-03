import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireInstanceRole, requireSuperadmin } from "../auth/middleware.js";
import { accessibleInstanceIds, effectiveInstanceRole } from "../auth/userService.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { instanceService } from "../instances/instanceService.js";
import type { UserRow } from "../db/repositories/userRepo.js";
import { HttpError, routeParam } from "../http/errors.js";
import { appLogger } from "../logging/appLogger.js";
import { getStartupQuery } from "../instances/healthPoller.js";
import { KNOWN_JAVA_VERSIONS } from "../docker/javaImage.js";
import { readServerProperties, writeServerProperties } from "../instances/serverProperties.js";
import {
  applyPackUpdate,
  checkForUpdate,
  createManualBackup,
  isUpdating,
  isWithinUpdateWindow,
  listPackVersions,
  packProvider,
  resolvePackLink,
  restoreBackup,
  validateUpdateWindow,
} from "../instances/packUpdates.js";
import { listBackups } from "../instances/backups.js";
import {
  describeMissingFiles,
  isInstallRunning,
  parseMissingFiles,
  storeManualDownload,
  uploadedFileNames,
} from "../curseforge/cfInstaller.js";

export const instancesRouter = Router();

function requireRow(id: string): InstanceRow {
  const row = instanceRepo.findById(id);
  if (!row) throw new HttpError(404, "Instance not found.");
  return row;
}
instancesRouter.use(requireAuth);

export function serializeInstance(instance: InstanceRow, requester: UserRow) {
  const { rcon_password: _rconPassword, missing_files: _missingFiles, ...safe } = instance;
  const uploaded = instance.missing_files ? uploadedFileNames(instance.id) : null;
  return {
    ...safe,
    effectiveRole: effectiveInstanceRole(requester, instance.id),
    installRunning: instance.source === "curseforge" && isInstallRunning(instance.id),
    updating: isUpdating(instance.id),
    updateWindowOpen: isWithinUpdateWindow(instance),
    /** A question the server is waiting on before it can finish starting (e.g. Forge's missing registry entries). */
    startupQuery: getStartupQuery(instance.id),
    missingFiles: parseMissingFiles(instance).map((file) => ({ ...file, uploaded: uploaded?.has(file.fileName) ?? false })),
  };
}

instancesRouter.get("/", (req, res) => {
  const all = instanceRepo.list();
  if (req.user!.global_role === "superadmin") {
    res.json(all.map((i) => serializeInstance(i, req.user!)));
    return;
  }
  const allowed = new Set(accessibleInstanceIds(req.user!));
  res.json(all.filter((i) => allowed.has(i.id)).map((i) => serializeInstance(i, req.user!)));
});

instancesRouter.get("/:id", requireInstanceRole("operator"), (req, res) => {
  const instance = instanceRepo.findById(routeParam(req, "id"));
  if (!instance) {
    res.status(404).json({ error: "Instance not found." });
    return;
  }
  res.json(serializeInstance(instance, req.user!));
});

const createInstanceSchema = z.object({
  name: z.string().min(1),
  subdomain: z.string().min(1),
  ftbModpackId: z.number().int(),
  ftbVersionId: z.number().int(),
  ftbPackName: z.string().min(1),
  memoryMb: z.number().int().min(512),
});

instancesRouter.post(
  "/",
  requireSuperadmin,
  async (req, res) => {
    const parsed = createInstanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const instance = await instanceService.createInstance(parsed.data);
    res.status(201).json(serializeInstance(instance, req.user!));
  }
);

const createCurseForgeSchema = z.object({
  name: z.string().min(1),
  subdomain: z.string().min(1),
  modId: z.number().int().positive(),
  fileId: z.number().int().positive(),
  memoryMb: z.number().int().min(512),
  javaVersion: z
    .number()
    .int()
    .refine((v) => (KNOWN_JAVA_VERSIONS as readonly number[]).includes(v), "Unsupported Java version.")
    .nullable()
    .default(null),
});

instancesRouter.post("/curseforge", requireSuperadmin, async (req, res) => {
  const parsed = createCurseForgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  const instance = await instanceService.createCurseForgeInstance(parsed.data);
  res.status(201).json(serializeInstance(instance, req.user!));
});

// Instance admins as well as superadmins: an admin's own update can land here.
instancesRouter.post("/:id/curseforge/retry", requireInstanceRole("admin"), async (req, res) => {
  await instanceService.retryCurseForgeInstall(routeParam(req, "id"));
  res.json({ ok: true });
});

// Names and download links for the files a blocked install waits for — from CurseForge (via cfClient's cache), not the database.
instancesRouter.get("/:id/curseforge/missing-files", requireInstanceRole("operator"), async (req, res) => {
  const instance = requireRow(routeParam(req, "id"));
  const uploaded = uploadedFileNames(instance.id);
  res.json((await describeMissingFiles(instance)).map((f) => ({ ...f, uploaded: uploaded.has(f.fileName) })));
});

// Raw body (application/octet-stream): one manually downloaded file for a blocked install.
instancesRouter.put("/:id/curseforge/files/:fileId", requireInstanceRole("admin"), async (req, res) => {
  const instance = instanceRepo.findById(routeParam(req, "id"));
  if (!instance) throw new HttpError(404, "Instance not found.");
  if (instance.status !== "awaiting_files") throw new HttpError(409, "This instance isn't waiting for any files.");
  await storeManualDownload(instance, Number(routeParam(req, "fileId")), req);
  res.json(serializeInstance(instanceRepo.findById(instance.id)!, req.user!));
});

// Admins only: confirming deletes the missing blocks/items from the world.
instancesRouter.post("/:id/startup-query", requireInstanceRole("admin"), async (req, res) => {
  const parsed = z.object({ answer: z.enum(["confirm", "cancel"]) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  await instanceService.answerStartupQuery(id, parsed.data.answer);
  res.json(serializeInstance(requireRow(id), req.user!));
});

// ---- server.properties ----

instancesRouter.get("/:id/properties", requireInstanceRole("admin"), async (req, res) => {
  res.json(await readServerProperties(requireRow(routeParam(req, "id"))));
});

const writePropertiesSchema = z.object({
  properties: z.record(z.string(), z.string()),
  revision: z.string().min(1),
  restart: z.boolean().default(false),
});

instancesRouter.put("/:id/properties", requireInstanceRole("admin"), async (req, res) => {
  const parsed = writePropertiesSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  const view = await writeServerProperties(requireRow(id), parsed.data.properties, parsed.data.revision);
  const row = requireRow(id);
  const running = row.status === "running" || row.status === "installing";
  if (parsed.data.restart && running) await instanceService.restartInstance(id);
  res.json({ ...view, restarted: parsed.data.restart && running });
});

// ---- modpack link (imported servers) ----

const packLinkSchema = z
  .object({
    provider: z.enum(["ftb", "curseforge"]),
    packId: z.number().int().positive(),
    versionId: z.number().int().positive(),
  })
  .nullable();

/**
 * Links an imported server to the modpack (and version) it is, or unlinks it
 * (body null). Platform admins only: the link decides what the server's next
 * update installs.
 */
instancesRouter.put("/:id/pack-link", requireSuperadmin, async (req, res) => {
  const parsed = packLinkSchema.safeParse(req.body?.pack ?? null);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  if (requireRow(id).source !== "import") throw new HttpError(409, "Only imported servers can be linked to a modpack.");
  const link = parsed.data ? await resolvePackLink(parsed.data.provider, parsed.data.packId, parsed.data.versionId) : null;
  instanceRepo.setPackLink(id, link);
  res.json(serializeInstance(requireRow(id), req.user!));
});

// ---- modpack versions & updates ----

// `?refresh=1`: the admin clicked force refresh (CurseForge version lists are otherwise reused for 12 hours).
const wantsRefresh = (value: unknown) => value === "1" || value === "true";

instancesRouter.get("/:id/versions", requireInstanceRole("admin"), async (req, res) => {
  const row = requireRow(routeParam(req, "id"));
  const current = packProvider(row) === "ftb" ? row.ftb_version_id : row.cf_file_id;
  const versions = await listPackVersions(row, { refresh: wantsRefresh(req.query.refresh) });
  res.json(versions.map((v) => ({ ...v, current: v.id === current })));
});

instancesRouter.post("/:id/updates/check", requireInstanceRole("admin"), async (req, res) => {
  const row = await checkForUpdate(routeParam(req, "id"), { refresh: wantsRefresh(req.query.refresh) });
  res.json(serializeInstance(row, req.user!));
});

const updateSettingsSchema = z.object({
  autoUpdate: z.enum(["off", "notify", "auto"]).optional(),
  // null clears the window (updates may then install at any time).
  window: z.object({ start: z.string(), end: z.string(), timeZone: z.string().min(1).max(64) }).nullable().optional(),
});

instancesRouter.put("/:id/updates/settings", requireInstanceRole("admin"), (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  requireRow(id);
  if (parsed.data.window) validateUpdateWindow(parsed.data.window);
  if (parsed.data.autoUpdate === "auto" && requireRow(id).source === "import") {
    throw new HttpError(
      400,
      "An imported server can't update automatically: its first update switches it to the modpack's own files, so do that one by hand."
    );
  }
  if (parsed.data.autoUpdate) instanceRepo.setAutoUpdate(id, parsed.data.autoUpdate);
  if (parsed.data.window !== undefined) instanceRepo.setUpdateWindow(id, parsed.data.window);
  res.json(serializeInstance(requireRow(id), req.user!));
});

// ---- backups ----

instancesRouter.get("/:id/backups", requireInstanceRole("admin"), async (req, res) => {
  res.json(await listBackups(requireRow(routeParam(req, "id"))));
});

instancesRouter.post("/:id/backups", requireInstanceRole("admin"), async (req, res) => {
  const name = await createManualBackup(routeParam(req, "id"));
  res.status(201).json({ name });
});

instancesRouter.post("/:id/backups/:name/restore", requireInstanceRole("admin"), async (req, res) => {
  const parsed = z.object({ switchVersion: z.boolean().default(true) }).safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  await restoreBackup(id, routeParam(req, "name"), parsed.data.switchVersion);
  res.json(serializeInstance(requireRow(id), req.user!));
});

instancesRouter.post("/:id/updates/apply", requireInstanceRole("admin"), async (req, res) => {
  const parsed = z.object({ versionId: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  const id = routeParam(req, "id");
  await applyPackUpdate(id, parsed.data.versionId, "manual");
  res.json(serializeInstance(requireRow(id), req.user!));
});

instancesRouter.post(
  "/:id/start",
  requireInstanceRole("operator"),
  async (req, res) => {
    await instanceService.startInstance(routeParam(req, "id"));
    res.json({ ok: true });
  }
);

// Records `stopping` and answers right away; the graceful shutdown (up to a minute) finishes in the
// background, and the server's status moves to `stopped` when it does.
instancesRouter.post("/:id/stop", requireInstanceRole("operator"), (req, res) => {
  const id = routeParam(req, "id");
  requireRow(id);
  instanceService.stopInstance(id).catch((err: unknown) => appLogger.error({ err, instanceId: id }, "stop failed"));
  res.status(202).json({ ok: true });
});

instancesRouter.post(
  "/:id/restart",
  requireInstanceRole("operator"),
  async (req, res) => {
    await instanceService.restartInstance(routeParam(req, "id"));
    res.json({ ok: true });
  }
);

const updateSubdomainSchema = z.object({ subdomain: z.string().min(1) });

instancesRouter.patch(
  "/:id",
  requireInstanceRole("admin"),
  async (req, res) => {
    const parsed = updateSubdomainSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    await instanceService.updateSubdomain(routeParam(req, "id"), parsed.data.subdomain);
    res.json(serializeInstance(instanceRepo.findById(routeParam(req, "id"))!, req.user!));
  }
);

const deleteQuerySchema = z.object({ deleteWorldData: z.enum(["true", "false"]).default("false") });

instancesRouter.delete(
  "/:id",
  requireInstanceRole("admin"),
  async (req, res) => {
    const parsed = deleteQuerySchema.safeParse(req.query);
    await instanceService.deleteInstance(routeParam(req, "id"), parsed.success && parsed.data.deleteWorldData === "true");
    res.status(204).end();
  }
);

instancesRouter.get(
  "/:id/logs",
  requireInstanceRole("operator"),
  async (req, res) => {
    res.type("text/plain").send(await instanceService.getRecentLogTail(routeParam(req, "id")));
  }
);
