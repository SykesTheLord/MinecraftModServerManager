import { Router } from "express";
import { z } from "zod";
import { verifyLogin } from "../auth/authService.js";
import { requireAuth } from "../auth/middleware.js";
import { appLogger } from "../logging/appLogger.js";
import { loginRetryAfterSeconds, recordLoginFailure, recordLoginSuccess } from "../auth/loginThrottle.js";

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }

  const { username, password } = parsed.data;
  const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const retryAfter = loginRetryAfterSeconds(clientIp, username);
  if (retryAfter > 0) {
    appLogger.warn({ clientIp, username }, "login throttled");
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
    return;
  }

  const user = await verifyLogin(username, password);
  if (!user) {
    recordLoginFailure(clientIp, username);
    appLogger.warn({ clientIp, username }, "failed login");
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }
  recordLoginSuccess(clientIp, username);

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Login failed." });
      return;
    }
    req.session.userId = user.id;
    appLogger.info({ username: user.username }, "user logged in");
    res.json({ id: user.id, username: user.username, globalRole: user.global_role });
  });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ id: req.user!.id, username: req.user!.username, globalRole: req.user!.global_role });
});
