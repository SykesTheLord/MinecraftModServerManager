# TODO

Living task list. Update this alongside the code — check items off as they
land, add new ones as they're found. Don't let it go stale.

## Done

- [x] Repo scaffold (npm workspaces: `server` Express/TS API, `web` Vite/React SPA).
- [x] SQLite schema + migrations (`user`, `instance_access`, `instance`, `settings`).
- [x] Auth: single seeded superadmin, session-based login, `requireAuth`/`requireSuperadmin`/`requireInstanceRole` middleware.
- [x] Multi-user, per-instance role grants (`admin`/`operator`), enforced server-side on every instance-scoped route.
- [x] FTB catalog integration (search modpacks, list versions) — verified live against `api.modpacks.ch`.
- [x] Docker Compose skeleton: `manager` + `infrared` (pinned `1.3.4`), shared `mc-net` network.
- [x] Instance lifecycle (`instanceService`): create/start/stop/restart/delete, with volume + Infrared route + health polling wired in.
- [x] Infrared route file writer, verified live: hot-reload confirmed working with zero Infrared restart.
- [x] Docker image auto-pull before container creation (Engine API doesn't auto-pull like `docker run` does — found by actually hitting it).
- [x] Per-instance Java image tag resolution from the modpack's own declared Java target — found by actually crash-looping two different real FTB packs on the wrong JVM.
- [x] Crash-loop detection via `RestartCount` (a naive `State.Running` check never notices a `restart: unless-stopped` container that's failing every boot) — found by actually watching one loop 8+ times.
- [x] Persistent logging: `logs/app.log` + `logs/instances/<id>/console.log`, both real host files, verified populated after a real deploy attempt.
- [x] Live console (WebSocket log tail + RCON command channel).
- [x] Dashboard, New Instance wizard, Instance detail, Users, Settings pages.
- [x] End-to-end smoke test against a live Docker daemon: login, FTB search, instance create, Infrared routing, crash detection, log persistence all verified working against real running containers (see verification log below).
- [x] `scripts/install.sh` (Docker Engine + Compose plugin install, detecting Debian/Ubuntu, Fedora, RHEL/CentOS/Rocky/AlmaLinux, Arch/Manjaro, openSUSE via `/etc/os-release`; idempotent; also sets up `.env`) and `scripts/apply.sh` (idempotent `docker compose up -d --build` wrapper with pre-flight checks). `apply.sh` verified live against the running stack; `install.sh`'s distro-detection logic was unit-tested in isolation (caught and fixed a real bug: RHEL/CentOS/Rocky/Alma all declare `ID_LIKE` containing "fedora" too, so the case-statement order matters) but its actual package-install branches weren't run end-to-end (no root in the dev sandbox).

- [x] Validation pass + fixes (verified against a live Docker daemon with real throwaway containers):
  - Async route handlers no longer crash the manager on failure (JSON `errorHandler` in `http/errors.ts`; missing instance → 404 — originally via an `asyncHandler` wrapper, now native since the Express 5 upgrade). Reproduced the crash first with `POST /api/instances/<bad-id>/start`.
  - Start on an already-running container (Docker 304) is a no-op instead of an error.
  - Log persistence and the live console survive Docker-initiated restarts, and resume without duplicating lines (tested across 6 real crash/restart cycles and a simulated manager outage: 0 duplicates, 0 gaps).
  - Console WebSocket no longer leaks a Docker log stream if the browser disconnects early; UI reconnects after a dropped connection.
  - Graceful stop: containers get `StopTimeout: 60` and every `stop()` passes `t: 60` (Docker's default 10s SIGKILL can corrupt a large modpack's world mid-save).
  - `installing` → `running` promotion falls back to an RCON probe when the "Done" line has scrolled out of the log tail.
  - Health poller: a crashed-and-restarting running server goes back to `installing`; crash-loop count is relative to the last successful boot; a vanished container becomes `error`; giving up also removes the Infrared route.
  - Boot reconcile also handles running containers the DB thinks are stopped/errored, stale route files, and rows stuck in `creating`.
  - Can't delete your own account or the last superadmin; access grants 404 on unknown user/instance.
  - UI surfaces action errors and no longer shows "Loading..." forever on a 403/404.
  - `MC_IMAGE` with a registry prefix resolves Java-tagged images correctly.
  - `better-sqlite3` 11 → 13 (11 has no build for Node ≥24); Docker image `node:20` → `node:22`.
- [x] Stack upgrade to current LTS/latest majors (smoke-tested in the built image against the live FTB API and Docker daemon, plus the Docker-backed log/poller regression checks):
  - Node 20/22 → **24 LTS** (`node:24-trixie-slim`, Debian 13); `engines.node >=24`; `@types/node` 24 to match.
  - Express 4 → 5 (native async error forwarding replaced `asyncHandler`; SPA fallback `"*"` → `"/{*splat}"`; `routeParam` helper for Express 5's param types).
  - zod 3 → 4 (`.passthrough()` → `z.looseObject`, `z.uuid()`, `z.prettifyError` for 400 messages).
  - TypeScript 5.9/6.0 → 7.0 in both workspaces; dockerode 4 → 5; bcryptjs 2 → 3 (bundles its own types); pino 9 → 10, pino-http 10 → 11, pino-pretty 11 → 13.
  - Removed `uuid` (→ `crypto.randomUUID()`, also clears its `npm audit` advisory) and the unused `cookie` dependency.
  - Dockerfile now uses `npm ci` against the root lockfile (previously `npm install --prefix` per workspace, which ignored the lockfile entirely), plus a `.dockerignore` so host `node_modules`/`dist` don't leak into the build.
  - Deliberately **not** bumped: `haveachin/infrared:1.3.4` (load-bearing pin, see CLAUDE.md) and `itzg/minecraft-server` (already tracks `stable`).

- [x] Security audit + fixes (all verified live: isolated manager container, curl probes, headless Chromium under the new CSP, a real itzg server booted with the hardened container config). Everything except the deployment's default admin password (test stack, left as-is by request):
  - Session cookies were being logged to `logs/app.log` (confirmed replayable) → redacted; existing log scrubbed.
  - No login throttling / username enumeration via timing (306ms vs 1ms) → per-IP + per-IP+user throttle, constant-time unknown-user path.
  - Console WebSocket accepted cross-origin handshakes; no CSRF check on writes → Origin/Sec-Fetch-Site checks.
  - Modpack containers could reach the manager API directly over mc-net → mc-net sources (except gateway) refused; port now bound to 127.0.0.1 by default (`MANAGER_BIND`).
  - No CSP/frame protection → strict CSP, `frame-ancestors 'none'`, XFO, nosniff, referrer policy, COOP; `X-Powered-By` off.
  - Password change needed no current password and left other sessions alive → both fixed; sessions now 12h idle timeout, `secure: "auto"`.
  - Instance containers had no memory/pids limits or privilege restrictions → added.
  - `.env` world-readable → `600` (install.sh, apply.sh).
  - `/api/docker/ping` unauthenticated; 500s leaked internal messages; WS maxPayload 100 MiB → fixed.
  - Production boot refuses a published/short `SESSION_SECRET`.

- [x] Import natively run servers (Import Server page): chunked archive upload or SSH pull from another machine (host-key pinning, password/key auth, optional sudo), platform/version/heap/world detection, review, deploy via `putArchive` into a new volume; `scripts/export-native-server.sh` for the upload path. Verified live — see "Importing natively run servers" in `docs/ARCHITECTURE.md` (real Fabric server imported both ways, booted with its original world; malicious tar/zip entries — `..`, absolute, symlink, hardlink — confirmed contained; every platform's detection checked against its install layout; full UI flow driven in headless Chromium under the CSP).

- [x] Pack discovery lists the whole FTB catalog (art, tags, MC version, loader, installs; filter/sort client-side; cached server-side), and versions show MC version/loader/date/release type with FTB's recommended memory as the default.
- [x] CurseForge integration: catalog search (query, MC version, loader, sort, paging), version picker, install via a short-lived keyed install container so the server never holds the API key, `awaiting_files` flow with SHA-1-verified uploads and retry, cleanup on delete/restart. Verified end to end against a local CurseForge API double with a real Fabric pack (see `docs/ARCHITECTURE.md`), via API and via the UI in headless Chromium.
- [x] UI refresh: design tokens with dark/light themes, top nav with active state, dashboard stat tiles and richer server cards (address + copy, source, memory), stepper wizard with pack grids, server page with details grid, install panel/checklist, danger zone. Checked in headless Chromium in both color schemes with zero console/CSP errors.

- [x] server.properties editor (managed keys read-only with reasons, lossless writes, revision-guarded, save & restart). Verified live through itzg restarts and in the UI.
- [x] Modpack updates: per-server off/notify/auto, update checks, one-click update / switch to any version, pre-update world backups (newest 3 at the time; now 5, see Backups below), conservative auto-apply (release, same MC version, empty server). Verified with a real FTB pack (manual 1.2.0 → 1.3.0, world kept) and a CurseForge pack via the API double (unattended auto-update).
- [x] `scripts/update.sh` self-update with DB backup, guards, health check and `--rollback`; version/commit in Settings → About. Verified end to end on a throwaway stack incl. rollback.
- [x] Health poller no longer promotes a restarted server to `running` from the previous boot's "Done" log line.

- [x] Backups tab: list, back up now (live-safe via RCON save-off/flush), and restore (safety backup first, wipe-then-extract, optional switch back to the backup's pack version); 5 kept with metadata sidecars. Verified with marker files end to end.
- [x] Time-of-day window for automatic updates (per server, own time zone, may cross midnight). Verified in the live scheduler (deferred outside, applied inside) and against DST/zone edge cases.

## Verified but worth re-checking periodically

- [ ] FTB's `api.modpacks.ch` endpoint shapes (unofficial, community-documented — could change without notice).
- [ ] The Infrared `v1.3.4` pin. Its config schema and hot-reload behavior are load-bearing for this whole design — do not bump the image tag without re-reading `server/src/infrared/configWriter.ts`'s doc comment and re-verifying against whatever version you're moving to.
- [ ] The `KNOWN_JAVA_TAGS` set in `server/src/docker/javaImage.ts` — itzg adds new Java-tagged image variants over time (e.g. a future `java29`); packs targeting a Java version not in that set silently fall back to the `stable` tag, which may or may not still work.

## Not yet done / deferred

- [ ] Real Minecraft-client join test with an actual game client (this session verified the full stack up through protocol-level Server List Ping routing — see below — which is everything short of an actual player joining; do the final client join once you have DNS pointed at a real host).
- [ ] Turn the ad-hoc Server List Ping probe used to verify routing in this session into a committed, repeatable script (it currently only exists as a one-off snippet run during development, not checked into the repo).
- [ ] Resource-limit editing on an existing instance (currently requires delete + recreate; changing `MEMORY` on a live container isn't supported by the underlying image).
- [ ] Subdomain-availability live-check in the New Instance wizard (currently only checked server-side on submit).
- [ ] Session store beyond in-memory (only matters once this needs to survive frequent manager restarts with multiple concurrent admins logged in).
- [ ] `tecnativa/docker-socket-proxy` hardening in front of the Docker socket (documented as a deferred mitigation, not a blocker).
- [ ] Real end-to-end run of `scripts/install.sh` on a clean VM/container for each covered distro family (Debian/Ubuntu, Fedora, RHEL/CentOS/Rocky/Alma, Arch/Manjaro, openSUSE) — only its distro-detection logic and `apply.sh`'s idempotency were actually exercised in this session.
- [ ] CI (lint/typecheck/build on push) — none configured yet.
- [ ] The deployment's `.env` still seeds `admin`/`change-me-immediately` (deliberately kept on this test stack). Before any real deployment: change it in the UI, and consider making first boot refuse/randomize a default `ADMIN_PASSWORD`.
- [ ] Existing instance containers keep their old config (no memory/pids limits, caps, or StopTimeout) until deleted and recreated.
- [ ] Node 26 becomes LTS on 2026-10-28 — move to it (Dockerfile `NODE_IMAGE`, `engines`, `@types/node`) once it does.
- [ ] Import: only the Fabric path was booted end-to-end; Forge/NeoForge/Quilt/Paper/vanilla/custom-jar detection was checked against synthetic install layouts and the itzg env names against the image's scripts, but not booted from a real imported server of each kind. Worth doing for at least one modern Forge (1.20.1) and one legacy Forge (1.12.2) server.
- [ ] Import: no SFTP-only / Windows source support (needs `tar` + a POSIX shell on the source machine; upload an archive instead). Staged imports don't survive a manager restart.
- [ ] CurseForge: run once against the **real** API with a real key and a real pack (development had no key; everything was verified against a test double that mimics the API shapes mc-image-helper and the manager use). Especially worth confirming: a pack with a genuinely distribution-blocked mod produces the `awaiting_files` list.
- [ ] Automated tests — none written yet; everything above was verified by hand against a live Docker daemon in this session, not by an automated test suite.

## Verification log (this session, against a real Docker daemon)

Full pipeline verified end-to-end with a real FTB modpack (FTB Presents
Direwolf20 1.16, a genuine ~100+ mod pack, not a toy):

- `docker compose up -d` → manager + infrared both start; only infrared publishes `25565`; `mc-*` containers never get published ports.
- Login, FTB search, instance creation all exercised via the real running API (not mocked).
- First real deploy attempt (a 1.7.10 Forge pack) crash-looped on the default Java tag with exactly the error itzg's own docs attribute to "wrong Java version" — this is what led to the `javaImage.ts` fix.
- Second attempt (the 1.16.4 pack) hit the same category of failure before the fix, and is what proved the crash-loop detection (`RestartCount`) fix was necessary — a naive running-check alone left it stuck on `installing` indefinitely.
- After both fixes: redeployed the 1.16.4 pack, correctly resolved to the `itzg/minecraft-server:java8` tag, and it reached genuine `running` status (real Forge mod loading observed in its logs — Bookshelf, Ars Nouveau, MineColonies, etc.).
- RCON round-trip confirmed twice: once via `rcon-cli` inside the instance container, once from the manager container to `mc-<id>:25575` over `mc-net` using the exact mechanism `rconClient.ts` uses in the app.
- Infrared route file creation confirmed to hot-reload live (`Registering proxy with UID ...` in its logs) with zero restart, for a real subdomain tied to a real running container.
- **Protocol-level routing proof**: sent raw Minecraft Server List Ping handshakes to `127.0.0.1:25565` with two different `Server Address` values — `test-dw20-v2` returned the real running server's actual status (`version: 1.16.4`), while an unmatched domain returned Infrared's own placeholder status. Confirms hostname-based routing genuinely works, not just that ports are open.
- `logs/app.log` and `logs/instances/<id>/console.log` both confirmed populated with real content.
- Full teardown verified clean: deleting the instance removed its container, volume, and Infrared route file with nothing left behind except the permanent `_placeholder.json`.
