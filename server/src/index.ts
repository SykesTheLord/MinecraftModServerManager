import http from "node:http";
import "./db/client.js"; // runs migrations as a side effect of import
import { env } from "./config/env.js";
import { appLogger } from "./logging/appLogger.js";
import { seedSuperadminIfNeeded } from "./auth/authService.js";
import { ensureNetworkExists } from "./docker/network.js";
import { reconcileInstancesOnBoot } from "./instances/reconcile.js";
import { createApp, sessionMiddleware } from "./app.js";
import { attachConsoleGateway } from "./ws/consoleGateway.js";
import { ensurePlaceholderRoute } from "./infrared/configWriter.js";
import { loadInstanceNetworkBlocklist } from "./http/security.js";

// Last line of defense: every known async path already handles its own
// errors, but one missed rejection shouldn't take down the manager (and log
// out every session with it).
process.on("unhandledRejection", (err) => {
  appLogger.error({ err }, "unhandled promise rejection");
});

async function main() {
  seedSuperadminIfNeeded();
  ensurePlaceholderRoute();
  await ensureNetworkExists();
  await loadInstanceNetworkBlocklist();

  const app = createApp();
  const server = http.createServer(app);
  attachConsoleGateway(server, sessionMiddleware);

  server.listen(env.MANAGER_PORT, () => {
    appLogger.info({ port: env.MANAGER_PORT }, "manager listening");
  });

  await reconcileInstancesOnBoot();
}

main().catch((err) => {
  appLogger.error({ err }, "fatal startup error");
  process.exit(1);
});
