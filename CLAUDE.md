# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted app that deploys FTB (Feed The Beast) Minecraft modpacks as
Docker containers and lets all of them share the standard Minecraft port
(25565) on one host, routing each incoming connection by the subdomain the
player's client sent (`pack1.mc.example.com`, `pack2.mc.example.com`, ...).
Controlled entirely through a web UI. See `docs/ARCHITECTURE.md` for the full
design writeup — this file is a condensed map for working in the code;
`docs/ARCHITECTURE.md` has the *why*, including several non-obvious findings
from actually running the stack that are load-bearing for correctness.

## Commands

This is an npm-workspaces monorepo: `server` (Express/TypeScript API) and
`web` (Vite/React SPA). Targets Node 24 (current Active LTS; `engines` in the
root `package.json`, `node:24-trixie-slim` in `server/Dockerfile`). Server is
Express 5 + zod 4; both workspaces build with TypeScript 7 (the native `tsc`).
The Docker build runs `npm ci` against the root `package-lock.json`, so
dependency changes only reach the image once the lockfile is updated.

```bash
npm install                 # from repo root — installs both workspaces

npm run dev:server          # server/: tsx watch src/index.ts (hot reload)
npm run dev:web             # web/: vite dev server

npm run build                # builds both workspaces
npm run typecheck            # typechecks both workspaces (tsc --noEmit, no build needed)

npm run typecheck -w server  # just the server
npm run typecheck -w web     # just the web app
npm run lint -w web          # oxlint (web only; server has no lint script)
```

There is no test suite yet (no test files, no test runner configured in
either workspace).

### Running the full stack (needs Docker)

```bash
sudo ./scripts/install.sh   # one-time: installs Docker Engine + Compose plugin
                             # (Debian/Ubuntu/Fedora/RHEL-family/Arch/openSUSE),
                             # creates .env with a generated SESSION_SECRET
./scripts/apply.sh          # docker compose up -d --build; safe to re-run anytime
./scripts/update.sh         # git-based self-update: DB backup → fast-forward → apply → health check
                             # (--check, --ref <tag>, --rollback backups/<ts>)
```

or by hand:

```bash
cp .env.example .env        # set ADMIN_USERNAME/PASSWORD, SESSION_SECRET, BASE_DOMAIN
docker compose up -d --build
```

This builds and runs two services: `manager` (the app, port `8080` by
default) and `infrared` (the routing proxy, port `25565`). Modpack instance
containers are **not** part of docker-compose — the manager creates/destroys
them at runtime via the Docker Engine API (`dockerode`), so `docker ps` is
the place to look for them (named `mc-<instanceId>`), not `docker compose
ps`.

Local (non-Docker) `npm run dev:server` still needs a real Docker daemon
reachable at `/var/run/docker.sock` to do anything useful — Docker control is
core to the app, not mockable.

## Architecture

### Three moving pieces, one network

- **manager** (`server/`) — the only thing with a Docker socket. Serves the
  API and the built React SPA (`web/dist` copied into `server/public` at
  Docker build time — see `server/Dockerfile`'s multi-stage build). Never
  sits in the player traffic path.
- **infrared** — a separate container (image `haveachin/infrared:1.3.4`,
  pinned deliberately — see below). The only thing that publishes 25565.
- **`mc-<instanceId>`** — one container per deployed modpack, created/
  started/stopped/removed by the manager via `dockerode`, never via
  docker-compose. All three kinds of container share a Docker user-defined
  network called `mc-net` (`env.DOCKER_NETWORK`); modpack containers get
  **no published ports** — they're reachable only by container name inside
  `mc-net`, which is how both Infrared's proxying and the manager's RCON
  connections reach them.

### "Dynamic image per modpack" without building anything

Every modpack instance runs the same base image
(`itzg/minecraft-server`, family docs at
https://docker-minecraft-server.readthedocs.io/), selected per instance via
env vars (`docker/containerSpec.ts`): `TYPE=FTBA`, `FTB_MODPACK_ID`,
`FTB_MODPACK_VERSION_ID`. The image downloads and boots that specific pack
itself. There is no per-modpack `docker build` anywhere in this system.

**The one thing that base image does *not* auto-match is the JVM.** Java
version is selected by *image tag* (`java8`, `java17`, `java21`, ...), not an
env var, and Forge below 1.18 requires the `java8` tag specifically or it
crash-loops. `docker/javaImage.ts` resolves the right tag per instance from
the modpack version's own declared Java target
(`ftb/ftbCatalogClient.ts#getModpackJavaMajorVersion`), and the resolved
image string is stored per-row in the `instance` table (`image` column) —
it is **not** a single global setting. If you're touching instance creation,
this resolution has to happen before `docker/images.ts#ensureImagePulled`
and container creation.

A `RestartPolicy: unless-stopped` container that keeps failing to boot gets
silently relaunched by Docker itself, so a plain `State.Running` check can't
tell a crash-loop from a slow-but-healthy boot — `instances/healthPoller.ts`
watches Docker's own `RestartCount` field instead and gives up (stops the
container, marks the instance `error` with the real log tail) once it
crosses a small threshold.

### Importing natively run servers

`imports/` + `routes/imports.routes.ts` (superadmin-only) bring an existing
server directory over — by chunked browser upload of a `.tar[.gz]`/`.zip`,
or by an SSH pull (`sshSource.ts`: remote `tar -cz` streamed into
extraction, host key pinned to a fingerprint the admin confirmed). Files are
staged in `DATA_DIR/imports/<jobId>` (in-memory job registry, wiped on
boot), analyzed (`analyze.ts` detects Forge/NeoForge/Fabric/Quilt/Paper/
vanilla/custom jar, MC + loader version, `-Xmx`, `level-name`), reviewed in
the UI, then deployed by `instanceService.createImportedInstance`, which
`putArchive`s them into the new volume (as uid 1000) before first start.
Imported rows have `source = 'import'` and their itzg env (`TYPE`,
`VERSION`, `FORGE_VERSION`, …) as JSON in `server_env`; `buildContainerConfig`
branches on that instead of emitting `TYPE=FTBA`. Extraction only writes
regular files/dirs inside the staging dir (no links) — keep it that way;
the archive comes from another machine. See `docs/ARCHITECTURE.md`.

### CurseForge modpacks (key never reaches a modpack)

`curseforge/cfClient.ts` (CurseForge API, needs `CF_API_KEY`;
`CF_API_BASE_URL` overrides the base, e.g. for a test double) and
`curseforge/cfInstaller.ts`. A short-lived install container
(`mc-install-<id>`, label `mcmgr.role=installer`) runs only `mc-image-helper
install-curseforge` into the volume with the key; the server container is
then built from the installer's `.curseforge-manifest.json`
(`minecraftVersion`, `modLoaderId`) as a plain `TYPE=FORGE/NEOFORGE/FABRIC/
QUILT` server — **never give a server container the key or
`TYPE=AUTO_CURSEFORGE`**. Files whose authors block automated downloads
(mc-image-helper only treats a CDN **404** as that) put the instance in
`awaiting_files`; uploads are SHA-1-checked against CurseForge and fed back
via `--downloads-repo`. See `docs/ARCHITECTURE.md` "CurseForge modpacks".

### server.properties editing and modpack updates

- `instances/serverProperties.ts` reads and writes `/data/server.properties`
  via the Docker archive API (`docker/containerFiles.ts`). Keys itzg rewrites
  from our env (RCON, plus `level-name` when `server_env` has `LEVEL`) and
  `server-port`/`server-ip` (Infrared needs 25565) are read-only with a
  reason. Writes are lossless and guarded by a content-hash revision.
- `instances/packUpdates.ts`: update = stop → backup → remove container →
  set new version → `provisionInstance` (FTB: itzg reinstalls on marker
  mismatch) or `installCurseForgeInstance` (CurseForge). The scheduler
  (5-minute ticks) auto-applies only release + same-Minecraft-version
  updates, only to running servers with 0 players per RCON, and only inside
  the server's optional time window (evaluated in its own IANA zone). Don't
  loosen those rules casually. Updates, restores and backups share one
  per-server lock (`withServerLock`).
- `instances/backups.ts`: backups live in the volume (`.update-backups/`,
  newest 5, `.json` sidecar with reason + pack version) and are made/listed/
  restored by `mcmgr.role=backup` containers. Restore deletes the archive's
  top-level paths *before* extracting (never mods/libraries) and backs up
  first; live backups pause saving over RCON.
- The health poller only looks for the "Done" line in logs since
  `State.StartedAt` — the previous boot's line otherwise promotes restarts
  instantly.

### Modpack source: FTB's own catalog (and CurseForge)

`ftb/ftbCatalogClient.ts` talks to `api.modpacks.ch/public/...`, the same
unauthenticated API backing the FTB App and
https://feed-the-beast.com/modpacks/server-files/linux. No API key. The UI
lists the whole catalog (`/modpack/all`, ~90 packs; details fetched 8 at a
time and cached 1h server-side). This is
community-documented, not an official versioned contract — if catalog calls
start failing, check whether the response shape has changed before assuming
a code bug.

### Infrared version pin is load-bearing — do not casually bump it

`docker-compose.yml` pins `haveachin/infrared:1.3.4` on purpose. The current
`master`/2.x branch is an alpha rewrite with a different config schema and,
confirmed by reading its source during development, **no hot-reload at all**
(config is read once at startup). v1.3.4 is what actually does the
fsnotify-based hot-reload this design depends on. `infrared/configWriter.ts`
writes one JSON file per instance (`domainName`/`listenTo`/`proxyTo` fields —
that exact schema, not YAML) into a directory Infrared watches. Two other
real behaviors baked into that file's logic:
- Infrared fatally exits if its config directory is ever completely empty,
  so a permanent harmless `_placeholder.json` route is maintained alongside
  real instance routes.
- Never let any other file (e.g. a stray `.gitkeep`) land in that directory —
  Infrared tries to parse every file in it as a proxy config and errors on
  anything that isn't valid JSON in its schema.

If you ever change the pinned Infrared version, `infrared/configWriter.ts`'s
doc comment and the write logic both need to be re-verified against the new
version's actual config format, not assumed.

### Data model (SQLite via `better-sqlite3`, `db/migrations/*.sql`)

- `user` — one `global_role` of `superadmin` or `user`. Seeded once from
  `.env` on first boot (`auth/authService.ts#seedSuperadminIfNeeded`).
- `instance_access` — per-(user, instance) grants of `admin` or `operator`.
  Superadmins don't need rows here; they implicitly pass every check.
- `instance` — one row per deployed modpack: FTB pack/version ids, resolved
  `image`, `source` (`ftb`|`import`|`curseforge`) + `server_env` (resolved
  itzg env for non-FTB sources), `cf_mod_id`/`cf_file_id`/`missing_files`
  (CurseForge), `container_id`/`container_name`/`volume_name`, per-instance
  `rcon_password`, and `status` (`creating|awaiting_files|installing|running|stopped|error|deleting`),
  plus update tracking (`auto_update`, `pack_version_name`,
  `available_version_*`, `update_checked_at`, `update_result`).
  Changing a CHECK constraint means rebuilding the table (see
  `0004_curseforge.sql`); `db/client.ts` runs migrations with foreign keys
  off so a rebuild can't cascade-delete `instance_access`.
  Docker is the actual source of truth for runtime state — `instances/reconcile.ts`
  reconciles DB status against real container state on manager boot.

### Access control

Enforced server-side per request, not just hidden in the UI —
`auth/middleware.ts`'s `requireInstanceRole(minRole)` checks either
`global_role === 'superadmin'` or a matching `instance_access` row before
allowing any instance-scoped action. `operator` covers start/stop/restart/
console; `admin` (per-instance) additionally covers delete, subdomain edit,
server.properties, pack updates/auto-update settings, and CurseForge
retry/manual-file upload.
Only a superadmin can create or import instances or manage users at all. The frontend
receives the caller's `effectiveRole` per instance in list/get responses
(`routes/instances.routes.ts`) so the UI can gate actions without guessing.

### Error handling in routes

Express 5 forwards rejected promises from async handlers to the error
handler itself, so async routes need no wrapper — just throw. Throw
`http/errors.ts#HttpError(status, message)` for expected failures (e.g.
`instanceService` throws 404/409s) and the shared `errorHandler` turns it into
a JSON response; anything else becomes a logged 500. Read route params with
`routeParam(req, "id")` — Express 5's types allow `string | string[]` (for
wildcard params) and the helper checks it's a string. Wildcard paths must be
named (`/{*splat}`); a bare `"*"` throws at startup under Express 5.

### Security controls (each one closed a confirmed hole — don't remove casually)

- **Origin checks** (`http/security.ts`): non-GET `/api` requests and console
  WebSocket upgrades are rejected if a browser sent them from another origin.
  `SameSite=Lax` alone doesn't stop sibling subdomains, and doesn't apply to
  WebSockets at all. Open consoles re-check their session and role before
  every command and every 30s (`ws/consoleGateway.ts`), closing with
  4401/4403, which the browser treats as final. Consequence: Vite's dev proxy must keep
  `changeOrigin: false` (see `web/vite.config.ts`).
- **Modpack network block**: HTTP/WS from `mc-net` addresses (other than its
  gateway) is refused — modpacks are untrusted third-party code sharing that
  network. Only closes the direct path; with `MANAGER_BIND=0.0.0.0` containers
  can still reach the manager via the host's address like any LAN device.
- **Login throttle** (`auth/loginThrottle.ts`): failures per IP and per
  IP+username; no global per-username lockout (would let anyone lock out the
  admin). Also guards the current-password check on password change. A dummy
  bcrypt compare for unknown users keeps timing from revealing usernames.
- **Log redaction** (`logging/appLogger.ts`): cookie/authorization headers
  are redacted — pino-http otherwise writes live session cookies to the
  browsable `logs/app.log`.
- **Password change** requires the current password and revokes the user's
  other sessions. Sessions idle out after 12h (`rolling`); cookies are
  `Secure` automatically over HTTPS.
- **Headers**: strict same-origin CSP (the built SPA has no inline
  script/style — keep it that way; no `style={…}` in JSX), `frame-ancestors
  'none'`, no `X-Powered-By`. `img-src` additionally allows only
  `http/artwork.ts#ARTWORK_HOSTS` (FTB/CurseForge CDNs); the catalog clients
  drop artwork on other hosts rather than widening the CSP.
- **Unexpected 500s** return a generic message; details go to the log. Throw
  `HttpError` when the client should see the message.
- **`TRUST_PROXY`** stays unset unless a reverse proxy is in front — trusting
  `X-Forwarded-*` from arbitrary clients defeats the throttle and origin checks.
- **Production boot refuses** a published/short `SESSION_SECRET` (`config/env.ts`).
- **Instance containers** (`docker/containerSpec.ts`): memory cap above the
  heap, `PidsLimit`, `no-new-privileges`, and a few dropped caps (notably
  `NET_RAW`, so a container can't spoof the gateway address the network block
  trusts). Verified booting a real itzg server; re-verify if you add more.

### Logging

Two independent things, both real files under `./logs` (a host bind mount in
docker-compose, not an opaque Docker volume, specifically so they're
directly browsable): `logs/app.log` (manager's own pino logs) and
`logs/instances/<instanceId>/console.log` (per-instance console history,
persisted independently of the ephemeral WebSocket tail used for the live UI
console — see `logging/instanceLogWriter.ts` vs `ws/consoleGateway.ts`).
Both go through `docker/logsStream.ts#followContainerLogs`, because a plain
Docker follow stream ends every time the container stops — including when
`unless-stopped` relaunches a crash — and would silently go quiet. It
re-follows after restarts and resumes from Docker's own per-line timestamps
(the persisted file resumes from its last line), so nothing is lost or
duplicated.

### Known accepted tradeoffs (see `docs/ARCHITECTURE.md` for detail — don't "fix" these without discussion)

- The manager holds `/var/run/docker.sock` (root-equivalent host access) —
  accepted for this tool's scope, mitigated by strong admin auth and not
  exposing the manager port publicly without your own TLS/VPN.
- Sessions are in-memory (`express-session`'s `MemoryStore`, `auth/sessionStore.ts`) — a manager
  restart logs everyone out.
