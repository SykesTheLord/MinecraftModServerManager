# Minecraft Mod Server Manager

A self-hosted web app for running many modded Minecraft servers on one host.
Each server runs in its own Docker container, and all of them share the
standard Minecraft port **25565**: players connect to `pack1.mc.example.com`,
`pack2.mc.example.com`, … and each connection is routed by the hostname their
client sent. No custom ports, no per-server firewall rules.

Everything is driven from the web UI:

- **Deploy modpacks from FTB or CurseForge** — browse the whole
  [Feed The Beast](https://feed-the-beast.com) catalog, or search
  [CurseForge](https://www.curseforge.com/minecraft/modpacks), pick a version,
  choose a subdomain and memory, deploy. The right Java runtime is picked
  automatically. For CurseForge, your API key stays with the manager (never
  inside a modpack's container), and mods whose authors block automated
  downloads are listed for you to fetch and upload, checksum-verified.
- **Import existing servers** — bring over a server that has been running
  natively (e.g. Forge/NeoForge/Fabric/Quilt/Paper/vanilla on an Ubuntu box),
  either pulled directly from that machine over SSH or uploaded as an archive.
  Mods, configs and the world come along; the platform and versions are
  detected for you to review before deploying.
- **Operate them** — start/stop/restart, a live console (log tail + RCON
  commands), an in-browser **server.properties editor**, crash-loop
  detection with the real log tail surfaced, and persistent per-server
  console logs on disk.
- **Keep packs current** — per-server update checks for FTB and CurseForge
  packs, one-click updates or switching to any version, and optional
  automatic updates (release versions on the same Minecraft version, applied
  only when the server is empty and, optionally, inside a daily time window),
  each preceded by a world backup.
- **Back up and restore** — world/config backups before every update and on
  demand (even while running), and one-click restore that can also switch
  the pack back to the version the backup was taken on.
- **Share access** — multiple users with per-server `operator` or `admin`
  roles, enforced server-side.

## How it works

```
                  players (*.mc.example.com:25565)
                              │
                     ┌────────▼────────┐
                     │    Infrared     │  routes by hostname
                     └────────┬────────┘
              mc-net          │   (Docker network, no published ports)
        ┌─────────────┬───────┴─────┬─────────────┐
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │ mc-<id> │   │ mc-<id> │   │ mc-<id> │   │ manager │ ◄── web UI (:8080)
   └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

- **manager** (`server/` + `web/`) — Express/TypeScript API serving a
  React SPA. The only component with access to the Docker socket; it creates
  and removes the server containers and writes the routing config.
- **[Infrared](https://github.com/haveachin/infrared)** — a Minecraft
  reverse proxy, the only thing publishing port 25565.
- **`mc-<id>` containers** — one per server, all on the
  [`itzg/minecraft-server`](https://docker-minecraft-server.readthedocs.io/)
  image, configured per instance through environment variables. No
  per-modpack image builds.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
the reasoning behind its less obvious choices.

## Requirements

- A Linux host with Docker Engine and the Compose plugin (the install script
  can set these up).
- **Wildcard DNS** pointing at the host, e.g. `*.mc.example.com → <host IP>`.
  The app doesn't manage DNS.
- Port `25565` free on the host, plus a port for the web UI (default `8080`).

## Quick start

```bash
git clone https://github.com/SykesTheLord/MinecraftModServerManager.git
cd MinecraftModServerManager

sudo ./scripts/install.sh   # installs Docker + Compose if needed, creates .env
# edit .env: set ADMIN_USERNAME / ADMIN_PASSWORD and BASE_DOMAIN
./scripts/apply.sh          # builds and starts the stack; safe to re-run
```

Or by hand: `cp .env.example .env`, fill it in (including a long random
`SESSION_SECRET`), then `docker compose up -d --build`.

The UI listens on `127.0.0.1:8080` by default, because it speaks plain HTTP
and controls Docker. From another machine, use an SSH tunnel
(`ssh -L 8080:localhost:8080 <host>`), a VPN, or a TLS reverse proxy (set
`TRUST_PROXY`). Log in with the credentials from `.env` and **change the
password straight away** under Settings.

Full instructions — deploying packs, importing servers, editing properties,
pack updates, managing access, logs and backups — are in
[`docs/USAGE.md`](docs/USAGE.md).

## Updating

```bash
./scripts/update.sh --check   # see what's new
./scripts/update.sh           # back up the database, update, rebuild, health-check
./scripts/update.sh --rollback backups/<timestamp>   # undo
```

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example) for the
documented list):

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First superadmin account (seeded on first boot only) |
| `SESSION_SECRET` | Signs session cookies; production refuses short or placeholder values |
| `BASE_DOMAIN` | Domain the subdomains hang off, e.g. `mc.example.com` |
| `MANAGER_PORT`, `MANAGER_BIND` | Where the web UI is published (default `127.0.0.1:8080`) |
| `TRUST_PROXY` | Only when a reverse proxy sits in front of the UI |
| `MC_IMAGE` | Base server image (default `itzg/minecraft-server:stable`) |
| `IMPORT_MAX_BYTES` | Largest server that can be imported (default 64 GiB) |
| `PACK_UPDATE_CHECK_HOURS` | How often servers check for modpack updates (default 6; 0 = never) |
| `CF_API_KEY` | CurseForge API key ([console.curseforge.com](https://console.curseforge.com/)); CurseForge is hidden without it |

## Development

An npm-workspaces monorepo targeting Node 24: `server/` (Express 5, zod,
better-sqlite3, dockerode) and `web/` (Vite + React).

```bash
npm install            # both workspaces
npm run dev:server     # API with hot reload (needs a reachable Docker daemon)
npm run dev:web        # Vite dev server, proxies /api and /ws to :8080
npm run typecheck      # both workspaces
npm run lint -w web
npm run build
```

There is no automated test suite yet; see [`docs/TODO.md`](docs/TODO.md) for
what has been verified by hand and what's still open.

## Security notes

The manager holds the Docker socket, which is root-equivalent access to the
host. Keep its port off the public internet unless it's behind your own
TLS/VPN, and use a strong admin password. Modpacks are treated as untrusted
code: their containers have memory and process limits, dropped capabilities,
and can't reach the manager's API over the shared network. Details are in
`docs/ARCHITECTURE.md` and `CLAUDE.md`.

## License

[MIT](LICENSE) © 2026 Jacob Sykes
