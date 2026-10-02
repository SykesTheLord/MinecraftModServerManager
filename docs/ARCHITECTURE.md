# Architecture

## What this is

A self-hosted app that deploys multiple modded Minecraft (FTB) servers as
separate Docker containers, and lets every one of them share the same public
port (25565) by routing incoming connections based on the subdomain the
player typed into their client — the same trick TLS/HTTP virtual hosting uses
(SNI), but applied to the Minecraft protocol's connection handshake.

## Components

```
                         ┌─────────────────────────┐
   player's client  ───▶ │  infrared (haveachin/    │
   pack1.mc.example.com  │  infrared:1.3.4)         │
   :25565                │  publishes :25565        │
                         └────────────┬─────────────┘
                                      │ reads handshake hostname,
                                      │ proxies raw TCP to the
                                      │ matching backend on mc-net
                                      ▼
                         ┌─────────────────────────┐      ┌─────────────────────────┐
                         │ mc-<instanceId>          │      │ mc-<instanceId>          │
                         │ itzg/minecraft-server     │ ...  │ itzg/minecraft-server     │
                         │ (one modpack each)        │      │ (one modpack each)        │
                         └─────────────────────────┘      └─────────────────────────┘
                                      ▲
                                      │ dockerode (Docker Engine API
                                      │ over /var/run/docker.sock)
                         ┌─────────────────────────┐
   admin's browser  ───▶ │  manager                 │
   :8080 (web UI/API)    │  Node/TS API + React SPA │
                         │  SQLite (users, instances)│
                         └─────────────────────────┘
```

- **manager** — the only thing an admin talks to. Holds the Docker socket,
  the SQLite database, and the FTB catalog client. Writes/removes one
  Infrared route file per instance on every lifecycle change. Never sits in
  the actual player traffic path.
- **infrared** — the only container that publishes 25565 to the host.
  Everything else is reachable only inside the `mc-net` Docker network.
- **mc-\<instanceId\>** — one container per deployed modpack, all from the
  same base image (`itzg/minecraft-server`), parameterized entirely through
  environment variables and a unique named volume. Created/started/stopped/
  removed at runtime by the manager via the Docker Engine API — never through
  `docker-compose` and never via a per-modpack `docker build`.

## "Dynamic Docker image" without building anything

The brief asked for the app to "create a dynamic docker image to run each
actual mod pack." In practice this is implemented as **one shared base image,
parameterized per instance**, not literal image builds:

- `TYPE=FTBA`, `FTB_MODPACK_ID`, `FTB_MODPACK_VERSION_ID` tell
  `itzg/minecraft-server` which FTB pack to download and boot; it also picks
  a matching Forge/Java runtime automatically.
- Each instance still gets a real, isolated, independently start/stoppable
  container and its own persistent volume — it's just never a bespoke
  Dockerfile.
- This is confirmed against itzg's own docs:
  https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/ftb/

Verified limitation (hit during implementation, not hypothetical): very old
modpacks can be fundamentally incompatible with the JVM this image selects —
e.g. a 1.7.10 Forge pack crash-looped with a `ClassCastException` from
legacy Forge's launch wrapper against a modern JDK. See "Crash-loop
detection" below for how this is surfaced instead of hanging forever.

## Importing natively run servers

Besides FTB packs, an existing server directory can be imported
(`server/src/imports/`, `routes/imports.routes.ts`, UI `ImportServerPage`).
It's the same "one base image, parameterized per instance" model, with the
files supplied instead of downloaded:

1. **Staging.** Files land in `DATA_DIR/imports/<jobId>/files` via either a
   chunked browser upload (`.tar[.gz]`/`.zip`, extracted server-side — Node
   kills requests that take over 5 minutes to *arrive*, so one big upload
   request would fail for large servers) or an SSH pull, where the manager
   runs `tar -cz` on the source machine and extracts the stream as it
   arrives (far faster than per-file SFTP for a modpack's many small
   files). Import jobs are in-memory, like sessions; staging is wiped on boot.
2. **Analysis** (`analyze.ts`) finds the server root inside wrapper
   directories and reads the platform from its install layout —
   `libraries/net/minecraftforge/forge/<mc>-<ver>`,
   `libraries/net/neoforged/…`, Fabric/Quilt loader libraries or launcher
   jar names, `paper-<mc>-<build>.jar`, `version.json` inside a vanilla
   `server.jar` — plus `-Xmx` and `level-name`.
3. **Deploy** (`instanceService.createImportedInstance`) creates the volume
   and container, copies the files in with Docker's `putArchive` *before the
   first start* (tar entries rewritten to uid/gid 1000, itzg's `minecraft`
   user — its entrypoint only re-chowns when `/data` itself has the wrong
   owner, which a fresh volume's doesn't), then starts it. The row has
   `source = 'import'` and its itzg env (`TYPE=FORGE`, `VERSION`,
   `FORGE_VERSION`, `LEVEL`, …; names checked against the image's
   `start-deploy*` scripts) in `server_env`; `ftb_*` ids are 0 and
   `ftb_pack_name` holds a display label.

itzg reinstalls the declared loader version next to the copied files rather
than running the old start scripts — that gives a known-good launch command
regardless of how the old box launched it. Java comes from the Minecraft
version (`javaImage.ts#javaMajorForMinecraftVersion`, ≤1.16 → 8) unless
overridden.

Security properties (import data comes from another machine):
- Extraction writes only regular files and directories; symlinks/hardlinks
  are dropped and every entry path is checked to stay inside the staging dir
  (yauzl additionally rejects zips with `..`/absolute names outright).
  Total extracted size is capped (`IMPORT_MAX_BYTES`).
- SSH host keys are pinned: the admin fetches the fingerprint
  (unauthenticated probe), verifies it out of band, and the pull refuses any
  other key — otherwise a MITM could harvest the credentials and substitute
  the files. Credentials are never persisted or logged. Remote paths are
  shell-quoted; exclude names and versions are allowlisted by regex.
- Everything is superadmin-only (it runs arbitrary server code, and the SSH
  source makes the manager open outbound connections wherever it's told).

Verified live: a real Fabric 1.20.1 server (Fabric API, custom
`level-name`, non-default port, `-Xmx6G` start script) imported both by
upload and by SSH pull (password and passphrase-protected ed25519 key, with
and without sudo, from an Ubuntu 24.04 sshd whose files were owned by a
separate service user); both booted to `running` with the original world
(same seed) on `java17`, port rewritten to 25565, `logs/`/`backups/`
excluded.

## CurseForge modpacks

`server/src/curseforge/` (`cfClient.ts`, `cfInstaller.ts`), routes in
`routes/curseforge.routes.ts` (catalog) and `routes/instances.routes.ts`
(`POST /instances/curseforge`, `…/curseforge/retry`,
`PUT …/curseforge/files/:fileId`). Needs `CF_API_KEY`.

**The key never reaches a modpack.** itzg's own `TYPE=AUTO_CURSEFORGE`
would need the key in the server container permanently (it re-syncs the
pack on every start), where any of the pack's third-party mods could read
it. Instead:

1. A short-lived **install container** (`mc-install-<id>`, label
   `mcmgr.role=installer`, same image, same hardening, default bridge
   network rather than `mc-net`, runs as uid 1000) runs only
   `mc-image-helper install-curseforge --slug … --file-id …` into the
   instance's volume, with the key in its env. It downloads the pack and
   mods, applies the pack's overrides, drops itzg's list of known
   client-only mods (`/image/cf-exclude-include.json`), and installs the mod
   loader — no pack code runs. Its output goes to the instance's
   `console.log` (the UI's install log), and it's removed afterwards.
2. The installer leaves `.curseforge-manifest.json` in the volume with
   `minecraftVersion` and `modLoaderId` (e.g. `forge-47.2.0`). Those field
   names were read from mc-image-helper's own classes (`javap`), then seen
   in a real run. The manager reads it via `getArchive` and stores an itzg
   env (`TYPE=FORGE|NEOFORGE|FABRIC|QUILT`, `VERSION`, loader version,
   `LEVEL`) in `server_env`, exactly like an imported server.
3. The **server container** is created from that env, with no key and no
   `AUTO_CURSEFORGE`. The rest of the lifecycle is the normal one.

**Mods whose authors disallow automated downloads.** mc-image-helper first
tries CurseForge's CDN for them. Only a **404** makes it give up on a file,
skip it, fail, and write `MODS_NEED_DOWNLOAD.txt` (a padded text table whose
last column is `https://www.curseforge.com/minecraft/mc-mods/<slug>/download/<fileId>`).
Anything else, e.g. a 403, is a hard failure. The manager extracts the file
ids from those URLs, looks them up (`POST /v1/mods/files`, `POST /v1/mods`)
for names, file names and SHA-1s, and puts the instance in
`awaiting_files` with that list in `missing_files`. Uploads are streamed to
`DATA_DIR/curseforge-downloads/<id>/mods/`, **rejected unless the SHA-1
matches CurseForge's** (MD5 when CurseForge lists no SHA-1; a file with
neither is refused, since it can't be verified), and copied into the volume's `.manual-downloads/`
before the next install attempt, which runs with
`--downloads-repo=/data/.manual-downloads`. mc-image-helper caches API
responses in the volume (2 days by default), so retries are fast.

Restarts and deletes: install containers left over from a manager restart
are removed on boot, and the instance goes to `error` with a retry button.
Deleting an instance removes its install container and staged uploads.

Schema: migration `0004_curseforge.sql` rebuilds the `instance` table,
because SQLite can't change the `source`/`status` CHECK constraints in place.
It adds `cf_mod_id`, `cf_file_id` and `missing_files`.
`db/client.ts#runMigrations` turns foreign keys off around migrations
(`PRAGMA foreign_keys` is ignored inside a transaction) and runs
`foreign_key_check` afterwards. Otherwise dropping the old table would
cascade-delete every `instance_access` grant. This was verified against a
pre-migration database with a grant in it.

Verified end to end against a local test double of the CurseForge API
(mc-image-helper accepts `--api-base-url`; the manager's `CF_API_BASE_URL`
feeds it). The test pack was a real Fabric 1.20.1 pack: Fabric API
downloadable, FerriteCore marked distribution-blocked (CDN 404), plus a
config override. The flow went create → install → `awaiting_files` with
FerriteCore listed → wrong jar rejected by checksum → correct jar accepted
→ continue → server running with 46 mods, `TYPE=FABRIC` and no key in its
env. It was driven both through the API and through the UI in headless
Chromium. **Not yet run against the real CurseForge API** (no key was
available during development); the request shapes follow CurseForge's
public docs and mc-image-helper's own client.

## Editing server.properties

`instances/serverProperties.ts`; routes `GET/PUT /instances/:id/properties`
(instance admin). The file is read and written through Docker's archive API
(`docker/containerFiles.ts`), so it works whether the server is running or
not. The written file is owned by uid 1000.

- **Managed keys are read-only, with the reason shown.** itzg rewrites a
  property at startup only when its env var is set (confirmed in
  `start-setupServerProperties`: existing files are only touched for set
  env vars). The manager sets `ENABLE_RCON`/`RCON_PASSWORD`/`RCON_PORT` (the
  console needs them) and, for imported/CurseForge servers, `LEVEL`. Infrared
  routes to `:25565` on every server, so `server-port`/`server-ip` are fixed
  too. Making these editable would only produce changes that silently
  revert, or a server the proxy can't reach. The RCON password is masked in
  responses.
- **Lossless round trip:** values are kept raw (Java `\u…` escapes
  included); unchanged lines are written back byte-for-byte; comments and
  order are preserved. Keys are validated, and values may not contain line
  breaks or control characters, so nothing can inject extra properties.
- **Optimistic concurrency:** reads return a content hash and writes must
  send it back. Minecraft itself rewrites the file at startup, so a stale
  editor gets a 409 instead of clobbering that.

Verified live: edits (including a removed key and a new one) survived
save-and-restart through itzg's startup; managed keys stayed put despite
attempts to change them; a stale revision and a value with a line break were
both rejected.

## Modpack updates

`instances/packUpdates.ts`; routes under `/instances/:id/versions` and
`/instances/:id/updates/*` (instance admin); columns from
`0005_pack_updates.sql` (`auto_update`, `pack_version_name`,
`available_version_*`, `update_checked_at`, `update_result`).

**Applying an update** (manual or automatic):
1. Stop the server.
2. Back it up (see "Backups and restore" below). If the backup fails, the
   server is put back as it was.
3. Remove the container, point the row at the new version (re-resolving
   Java: FTB from its metadata; CurseForge from the Minecraft version, unless
   it's unchanged, which keeps an admin's explicit choice), and re-provision
   into the same volume:
   - **FTB:** the new `FTB_MODPACK_VERSION_ID` no longer matches itzg's
     `.ftb-installed` marker, so its `start-deployFTBA` re-runs FTB's
     installer with `-force` (read from the image's script).
   - **CurseForge:** the install container runs again with the new file id.
     mc-image-helper replaces the previous version's files using its own
     manifest. A blocked download lands in `awaiting_files`, exactly like a
     first install. That's why CurseForge retry/upload are open to instance
     admins, not just superadmins.
   The check timestamp is cleared, so the next tick re-checks: a different
   version can have different updates (e.g. after restoring back to an old
   one).

Updates, restores and backups share one per-server lock, so they never
overlap on a server.

**Automatic updates** (`startPackUpdateScheduler`: first tick 2 minutes after
boot, then every 5 minutes; checks are due every `PACK_UPDATE_CHECK_HOURS`).
They only apply *release* versions on the *same Minecraft version*, and only
to a server that's `running` with **0** players according to RCON `list`. An
unknown player count counts as busy and is logged. If the server has a
**time window** (`update_window_start`/`_end`/`_tz`, migration 0006), the
tick must also fall inside it. The window is evaluated in its own IANA
zone via `Intl` (the manager runs in UTC), may cross midnight, and is
inclusive at the start and exclusive at the end. A Minecraft-version change
can be irreversible for a world, so it's never automatic.

Verified live with a real FTB pack (FTB Unstable 1.20: Fabric, manual
1.2.0 → 1.3.0: FTB's installer re-ran, same world seed afterwards, backup
taken). Also verified with a CurseForge pack via the API test double:
`notify` and `auto` both detected 1.1.0 on the first tick, `auto` applied it
to the empty server unattended, the new pack's files were in place, the
admin's server.properties edits survived, and the backup held the world and
configs but not mods. The manager must be on `mc-net` (as in docker-compose)
for the RCON player check. A manager run on the host can't resolve
container names, so it correctly never auto-applies.

**Health-poller fix that came out of this:** promotion from `installing` to
`running` used to search the last 50 log lines for "Done (…)!", and after a
restart that matched the *previous* boot's line, so the server showed
`running` instantly. It now only looks at logs since the container's
`State.StartedAt`.

## Backups and restore

`instances/backups.ts`; routes `GET/POST /instances/:id/backups`,
`POST /instances/:id/backups/:name/restore` (instance admin).

- **Format:** a `.tar.gz` of the volume minus re-downloadable/regenerated
  paths (mods, libraries, versions, logs, caches, the backups themselves),
  plus a `.json` sidecar with the reason (`update`/`manual`/`restore`), the
  pack version id/name, and the time. Everything is written by throwaway
  containers (label `mcmgr.role=backup`, no network, uid 1000) mounting the
  volume. Nothing is copied out to the manager, and listing works the same
  way, since `getArchive` on the directory would stream every archive. The
  newest 5 are kept.
- **Live backups** pause saving over RCON (`save-off`, `save-all flush`, a
  short wait, then `save-on`). RCON is retried for a few seconds, because
  Minecraft prints "Done" a moment before its RCON listener is up.
- **Restore:** stop → back up the current state, with the restore source
  protected from rotation → delete exactly the top-level paths the archive
  contains (never mods/libraries/backups) → extract → restart if it was
  running. Deleting first matters: extracting over a newer world would mix
  old and new region files. If the backup's recorded version differs and the
  admin asks for it, the pack is then switched to that version, without a
  second backup, since the volume *is* a backup at that point.
- Backup names are validated against a strict pattern *and* must appear in
  the listing before a restore runs.

Verified live (CurseForge pack via the API double, manager on `mc-net`),
using marker files in the world:
- A live backup paused and resumed saving and the server kept running.
- An update kept the world and swapped the pack files.
- Restoring a pre-update backup with the version switch brought back the
  old marker, removed a file created after that backup, put the pack back
  on its old version, and kept the world seed.
- Restoring the automatic safety backup brought the newer state back.
- Restoring the oldest of 5 backups worked (rotation protection).
- Retention stayed at 5, each with a sidecar.
- A window excluding "now" deferred a pending auto-update (logged), and the
  first tick after widening it applied the update.
- Window logic was checked at fixed instants across BST/GMT, a window
  crossing midnight, New York and Tokyo, and invalid inputs.

## Updating the manager (`scripts/update.sh`)

Git-based. The checkout must be clean, and the script refuses while a helper
container (`mcmgr.role`: CurseForge install or pre-update backup) is
running, unless `--force`. With the manager stopped it copies the SQLite
files (including `-wal`/`-shm`, consistent because nothing is writing) to
`backups/<timestamp>/` with the commit. It then fast-forwards, runs
`apply.sh`, and health-checks from inside the container. `--rollback`
resets the checkout to the recorded commit, rebuilds, and replaces the
database files exactly; a stale `-wal` from the newer version would otherwise
be replayed onto the restored database. `apply.sh` stamps the image with
`APP_COMMIT` (with `-modified` for a dirty tree), and **Settings → About**
shows it.

Verified end to end on a throwaway stack (own compose project, ports and
network), with a bare-repo upstream one commit ahead:
- `--check` listed the new commit.
- The dirty-tree and busy guards refused.
- The update backed up, moved, rebuilt, came up healthy, and kept the data.
- `--rollback` restored the old version *and* the old database (a user
  created after the update was gone).
- Updating forward again worked.

## Pack artwork and the CSP

The catalog UIs show pack art straight from FTB's and CurseForge's CDNs.
`img-src` allows exactly `http/artwork.ts#ARTWORK_HOSTS`
(`apps.modpacks.ch`, `cdn.creeper.host`, `media.forgecdn.net`), and the
catalog clients drop artwork URLs on any other host (a few FTB packs link
art elsewhere). Those packs show a placeholder instead of a CSP-blocked
image, and the policy isn't widened for arbitrary hosts.

## Modpack source: FTB's own catalog, not CurseForge

(Historical heading. CurseForge is now supported too, see above. FTB stays
the zero-configuration default.)

`server/src/ftb/ftbCatalogClient.ts` calls `api.modpacks.ch/public/...` — the
same unauthenticated API that backs both the FTB App and
https://feed-the-beast.com/modpacks/server-files/linux. No API key needed.
Confirmed live during implementation:
- `GET /public/modpack/all` → `{ packs: number[] }` — every public pack id
  (~90). The UI lists the whole catalog. The manager fetches every pack's
  details (8 at a time) and caches the summaries for an hour, which takes
  under a second cold. A failed refresh serves the stale copy.
- `GET /public/modpack/{id}` → `{ id, name, synopsis, art, tags, installs,
  updated, versions: [{id, name, type, updated, specs: {recommended},
  targets: [{name, version, type}]}] }`. Each version's targets give the
  Minecraft version, mod loader and Java version, and `specs.recommended` is
  FTB's recommended memory, used as the default.

This is community-documented rather than an officially versioned contract, so
it could change without notice — worth a periodic sanity check.

## Routing: why Infrared is pinned to v1.3.4, and the exact config format

This mattered enough to get wrong that it's worth spelling out. Infrared's
current `master`/2.x branch is an alpha-tagged rewrite that:
- uses a different config schema (`domains`/`addresses` lists in YAML), and
- **reads its config once at startup — no hot-reload at all** (confirmed by
  reading `pkg/infrared/config/file.go` and `pkg/infrared/infrared.go`
  directly; there is no fsnotify or watcher anywhere in that code path).

The last stable v1 release (`v1.3.4`) is what's actually pinned in
`docker-compose.yml`, because it's the version that does what this project's
design depends on:
- Config format is JSON, one file per proxy, with fields
  `domainName` / `listenTo` / `proxyTo` (confirmed against
  `github.com/haveachin/infrared` at tag `v1.3.4`, `config.go`).
- `cmd/infrared/main.go` calls `infrared.WatchProxyConfigFolder(configPath, ...)`
  which really does use `fsnotify` — routes added/removed by the manager take
  effect immediately, with no Infrared restart.
- Config path is controlled by `INFRARED_CONFIG_PATH` (default `./configs`).

`server/src/infrared/configWriter.ts` writes `<instanceId>.json` files
matching this exact schema. **Do not upgrade the pinned Infrared image tag
without re-verifying this file against whatever version you move to** — the
two branches are not config-compatible.

Two more real behaviors discovered by actually running this, not assumed:
- **Infrared's gateway fatally exits ("no proxies in gateway") if its config
  directory is completely empty at startup.** A fresh install has zero
  instances, so `configWriter.ts` also maintains a permanent
  `_placeholder.json` route (harmless, matches no real subdomain, proxies to
  a closed local port) purely so Infrared always has something to load.
  Docker's `restart: unless-stopped` policy papers over the brief startup
  race against the manager writing that file on its own first boot.
- Never place any other file (e.g. a `.gitkeep`) inside the mounted configs
  directory — Infrared tries to parse every file in it as a proxy config and
  fatally errors on anything that isn't valid JSON in its schema.

## Networking model

- `mc-net` is a Docker user-defined bridge network. Infrared, the manager,
  and every `mc-<instanceId>` container all join it.
- `mc-<instanceId>` containers are created with **no published ports** —
  reachable only by container name inside `mc-net` (Docker's embedded DNS
  resolves `mc-<instanceId>` for both Infrared's proxying and the manager's
  RCON connections).
- The manager itself must be on `mc-net` too — not just holding the Docker
  socket — because live console commands go over a real RCON TCP connection
  from the manager process to `mc-<instanceId>:25575`.

## Crash-loop detection

`docker run`'s auto-pull behavior does not apply to the Engine API —
`docker/images.ts` explicitly pulls the image if it isn't already present
before creating a container (this was missing initially and surfaced
immediately as a "no such image" error on the very first real instance
creation).

A more subtle bug, also found by actually deploying a real (if
incompatible) modpack: containers are created with
`RestartPolicy: unless-stopped`, so a modpack that crashes on every boot gets
silently relaunched by Docker itself. Naively polling `State.Running` sees
`true` again moments later and never notices the failure — the instance
would sit on "installing" forever. `instances/healthPoller.ts` instead
watches Docker's own `RestartCount` field and, once it crosses a small
threshold while still "installing," stops the container explicitly and
surfaces the real log tail as the instance's error — this is what a modpack
that's fundamentally incompatible with the selected JVM looks like in the UI,
rather than a silent hang.

## Multi-user access control

Two levels, enforced server-side on every instance-scoped route
(`auth/middleware.ts`'s `requireInstanceRole`):
- `superadmin` — full control of everything, only role that can create
  instances or manage users.
- Per-instance grants (`instance_access` table) — a specific user can be
  handed `operator` (start/stop/restart/console) or `admin` (also
  delete/subdomain-edit) rights scoped to exactly the instances they're
  granted. Enforced at the application layer only: a granted user can run
  arbitrary RCON/console commands inside *their* container, but the app never
  lets their session reach Docker Engine calls for anything else.

## Logging

Two independent things, both real files on disk (mounted as `./logs` in
`docker-compose.yml`, not opaque Docker volumes, specifically so an admin can
open them with a normal editor):
- `logs/app.log` — the manager's own structured logs (pino).
- `logs/instances/<instanceId>/console.log` — each instance's console
  output, persisted independently of the ephemeral WebSocket tail used for
  the live UI console, so history survives a manager restart.

## Known accepted tradeoffs (not bugs — documented for the next person)

- The manager holds `/var/run/docker.sock`, which is root-equivalent host
  access. Mitigate with strong admin auth and not exposing the manager's port
  publicly without your own TLS/VPN in front. A future hardening step would
  be swapping in `tecnativa/docker-socket-proxy` scoped to only the Engine
  API calls actually used.
- Sessions are in-memory (`express-session`'s `MemoryStore`) — restarting the
  manager logs everyone out. Fine at this tool's scale (a handful of admins);
  would need a real session store to matter beyond that.
- DNS is entirely the operator's responsibility — this app only writes
  routing config, it never touches DNS records. Wildcard DNS
  (`*.mc.example.com`) pointed at the host is a prerequisite.
