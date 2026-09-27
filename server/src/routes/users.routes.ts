import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperadmin } from "../auth/middleware.js";
import {
  changePassword,
  createUser,
  deleteUser,
  grantInstanceAccess,
  listInstanceAccessForUser,
  listUsers,
  revokeInstanceAccess,
} from "../auth/userService.js";
import { userRepo } from "../db/repositories/userRepo.js";
import { instanceRepo } from "../db/repositories/instanceRepo.js";
import { routeParam } from "../http/errors.js";
import { verifyPassword } from "../auth/authService.js";
import { revokeUserSessions } from "../auth/sessionStore.js";
import { loginRetryAfterSeconds, recordLoginFailure } from "../auth/loginThrottle.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get("/", requireSuperadmin, (_req, res) => {
  res.json(
    listUsers().map((u) => ({ id: u.id, username: u.username, globalRole: u.global_role }))
  );
});

const createUserSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
  globalRole: z.enum(["superadmin", "user"]).default("user"),
});

usersRouter.post("/", requireSuperadmin, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  try {
    const user = await createUser(parsed.data.username, parsed.data.password, parsed.data.globalRole);
    res.status(201).json({ id: user.id, username: user.username, globalRole: user.global_role });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Failed to create user." });
  }
});

usersRouter.get("/:id/access", requireSuperadmin, (req, res) => {
  res.json(listInstanceAccessForUser(routeParam(req, "id")));
});

usersRouter.delete("/:id", requireSuperadmin, (req, res) => {
  const target = userRepo.findById(routeParam(req, "id"));
  if (!target) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ error: "You cannot delete your own account." });
    return;
  }
  // The seed superadmin is only recreated when the user table is completely
  // empty, so removing the last superadmin would lock everyone out for good.
  if (target.global_role === "superadmin" && listUsers().filter((u) => u.global_role === "superadmin").length <= 1) {
    res.status(400).json({ error: "Cannot delete the last superadmin." });
    return;
  }
  deleteUser(target.id);
  void revokeUserSessions(target.id);
  res.status(204).end();
});

const accessGrantSchema = z.object({
  instanceId: z.uuid(),
  role: z.enum(["admin", "operator"]),
});

usersRouter.put("/:id/access", requireSuperadmin, (req, res) => {
  const parsed = accessGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  if (!userRepo.findById(routeParam(req, "id"))) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (!instanceRepo.findById(parsed.data.instanceId)) {
    res.status(404).json({ error: "Instance not found." });
    return;
  }
  grantInstanceAccess(routeParam(req, "id"), parsed.data.instanceId, parsed.data.role);
  res.json({ ok: true });
});

usersRouter.delete("/:id/access/:instanceId", requireSuperadmin, (req, res) => {
  revokeInstanceAccess(routeParam(req, "id"), routeParam(req, "instanceId"));
  res.status(204).end();
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  password: z.string().min(8).max(1000),
});

usersRouter.put("/me/password", async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Current password is required, and the new password must be at least 8 characters." });
    return;
  }
  const user = req.user!;
  // Throttled like login: this endpoint also answers "is this the password?"
  // for whoever holds the session.
  const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const retryAfter = loginRetryAfterSeconds(clientIp, user.username);
  if (retryAfter > 0) {
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many failed attempts. Try again later." });
    return;
  }
  // Requiring the current password means a stolen/borrowed session can't be
  // turned into a permanent account takeover.
  if (!(await verifyPassword(user, parsed.data.currentPassword))) {
    recordLoginFailure(clientIp, user.username);
    res.status(403).json({ error: "Current password is incorrect." });
    return;
  }
  await changePassword(user.id, parsed.data.password);
  // Log out everywhere else, so anyone holding an old session is cut off.
  await revokeUserSessions(user.id, req.sessionID);
  res.json({ ok: true });
});
