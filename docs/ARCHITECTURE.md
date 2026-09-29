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

## Modpack source: FTB's own catalog, not CurseForge

`server/src/ftb/ftbCatalogClient.ts` calls `api.modpacks.ch/public/...` — the
same unauthenticated API that backs both the FTB App and
https://feed-the-beast.com/modpacks/server-files/linux. No API key needed.
Confirmed live during implementation:
- `GET /public/modpack/search/{limit}?term=...` → `{ packs: number[] }`
- `GET /public/modpack/{id}` → `{ id, name, synopsis, versions: [{id, name, type}, ...] }`

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
