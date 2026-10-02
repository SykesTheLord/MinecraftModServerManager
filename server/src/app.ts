import path from "node:path";
import express, { type RequestHandler } from "express";
import session from "express-session";
import { pinoHttp } from "pino-http";
import { env, trustProxy } from "./config/env.js";
import { appLogger } from "./logging/appLogger.js";
import { authRouter } from "./routes/auth.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { instancesRouter } from "./routes/instances.routes.js";
import { importsRouter } from "./routes/imports.routes.js";
import { curseforgeRouter } from "./routes/curseforge.routes.js";
import { ftbRouter } from "./routes/ftb.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";
import { errorHandler } from "./http/errors.js";
import { rejectInstanceNetwork, requireSameOriginForWrites, securityHeaders } from "./http/security.js";
import { requireAuth } from "./auth/middleware.js";
import { sessionStore } from "./auth/sessionStore.js";

export const sessionMiddleware: RequestHandler = session({
  store: sessionStore,
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Idle timeout: `rolling` re-issues the cookie on every response, so a
  // session only expires after 12 hours without any request.
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // Marked Secure whenever the request arrived over HTTPS (directly, or via
    // a TLS proxy when TRUST_PROXY is set); plain-HTTP deployments still work.
    secure: "auto",
    maxAge: 1000 * 60 * 60 * 12,
  },
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);

  app.use(pinoHttp({ logger: appLogger }));
  app.use(rejectInstanceNetwork);
  app.use(securityHeaders);
  app.use(express.json());
  app.use(sessionMiddleware);
  app.use("/api", requireSameOriginForWrites);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/docker/ping", requireAuth, async (_req, res) => {
    const { docker } = await import("./docker/dockerClient.js");
    try {
      await docker.ping();
      res.json({ ok: true });
    } catch (err) {
      appLogger.error({ err }, "docker ping failed");
      res.status(500).json({ ok: false });
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/instances", instancesRouter);
  app.use("/api/imports", importsRouter);
  app.use("/api/curseforge", curseforgeRouter);
  app.use("/api/ftb", ftbRouter);
  app.use("/api/settings", settingsRouter);

  const webDist = path.join(process.cwd(), "public");
  app.use(express.static(webDist));
  // Express 5 (path-to-regexp v8) requires wildcards to be named; a bare "*" throws at startup.
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);

  return app;
}
