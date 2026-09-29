import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireInstanceRole, requireSuperadmin } from "../auth/middleware.js";
import { accessibleInstanceIds, effectiveInstanceRole } from "../auth/userService.js";
import { instanceRepo, type InstanceRow } from "../db/repositories/instanceRepo.js";
import { instanceService } from "../instances/instanceService.js";
import type { UserRow } from "../db/repositories/userRepo.js";
import { routeParam } from "../http/errors.js";

export const instancesRouter = Router();
instancesRouter.use(requireAuth);

export function serializeInstance(instance: InstanceRow, requester: UserRow) {
  const { rcon_password: _rconPassword, ...safe } = instance;
  return { ...safe, effectiveRole: effectiveInstanceRole(requester, instance.id) };
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

instancesRouter.post(
  "/:id/start",
  requireInstanceRole("operator"),
  async (req, res) => {
    await instanceService.startInstance(routeParam(req, "id"));
    res.json({ ok: true });
  }
);

instancesRouter.post(
  "/:id/stop",
  requireInstanceRole("operator"),
  async (req, res) => {
    await instanceService.stopInstance(routeParam(req, "id"));
    res.json({ ok: true });
  }
);

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
