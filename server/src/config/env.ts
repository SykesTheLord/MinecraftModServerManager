import { z } from "zod";

const envSchema = z.object({
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(1).default("change-me-immediately"),
  SESSION_SECRET: z.string().min(1).default("dev-only-insecure-secret"),
  BASE_DOMAIN: z.string().min(1).default("mc.example.com"),
  MANAGER_PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().min(1).default("/app/data"),
  LOGS_DIR: z.string().min(1).default("/app/logs"),
  INFRARED_CONFIG_DIR: z.string().min(1).default("/app/infrared-configs"),
  DOCKER_NETWORK: z.string().min(1).default("mc-net"),
  MC_IMAGE: z.string().min(1).default("itzg/minecraft-server:stable"),
  /**
   * Largest server (total extracted size) that can be imported. Imports are
   * staged under DATA_DIR before being copied into their volume, so this
   * mostly guards the disk against a runaway archive. Default 64 GiB.
   */
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(64 * 1024 ** 3),
  /**
   * CurseForge API key (https://console.curseforge.com/), required for the
   * CurseForge catalog — without it only FTB packs and imports are offered.
   * Only the manager and its short-lived install containers ever see it,
   * never a running modpack (see curseforge/cfInstaller.ts).
   */
  CF_API_KEY: z.string().trim().optional(),
  /** CurseForge API base URL; only worth changing for a mirror/proxy (or a test double). */
  CF_API_BASE_URL: z.string().url().default("https://api.curseforge.com"),
  /**
   * How often FTB/CurseForge servers are checked for a newer version of their
   * pack (servers set to "auto" also get it applied when empty). 0 disables
   * checking entirely. See instances/packUpdates.ts.
   */
  PACK_UPDATE_CHECK_HOURS: z.coerce.number().min(0).default(6),
  /** Set at image build time by scripts/apply.sh; shown in Settings → About. */
  APP_COMMIT: z.string().default("unknown"),
  /**
   * Express "trust proxy" setting, only needed when the manager sits behind
   * a reverse proxy (e.g. for TLS). Leave unset otherwise: trusting
   * X-Forwarded-* headers from arbitrary clients would let them spoof their
   * IP (defeating login rate limiting) and the host used for origin checks.
   * Accepts "true", a hop count, or an address/subnet list (see Express docs).
   */
  TRUST_PROXY: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export const trustProxy: boolean | number | string = (() => {
  const value = env.TRUST_PROXY?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  return /^\d+$/.test(value) ? Number(value) : value;
})();

// Values that ship in this repo (env default, docker-compose default,
// .env.example placeholder) are public, so signing sessions with them is no
// secret at all. Refuse to run a production build with one.
const PUBLIC_SESSION_SECRETS = new Set(["dev-only-insecure-secret", "replace-with-a-long-random-string"]);
if (
  process.env.NODE_ENV === "production" &&
  (PUBLIC_SESSION_SECRETS.has(env.SESSION_SECRET) || env.SESSION_SECRET.length < 32)
) {
  throw new Error(
    "SESSION_SECRET is unset, a published placeholder, or shorter than 32 characters. " +
      "Set a long random value in .env (e.g. `openssl rand -hex 32`)."
  );
}
