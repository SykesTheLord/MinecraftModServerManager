# Usage

## Prerequisites

- A Linux host with Docker and Docker Compose installed.
- Wildcard DNS pointed at that host, e.g. `*.mc.example.com -> <host IP>`.
  This app never touches DNS — it only assumes it already resolves.
- Port `25565` free on the host (used by Infrared) and whatever port you pick
  for the admin UI (default `8080`).

## First run

`scripts/install.sh` and `scripts/apply.sh` automate the steps below —
`install.sh` installs Docker Engine + the Compose plugin (detects Debian,
Ubuntu, Fedora, RHEL/CentOS/Rocky/AlmaLinux, Arch/Manjaro, or openSUSE via
`/etc/os-release`, and skips straight to repo setup if Docker's already
present) and creates `.env` with a generated `SESSION_SECRET`; `apply.sh`
builds/pulls and starts the stack, and is safe to re-run any time afterward
(e.g. after `git pull` or editing `.env`) to bring it up to date:

```bash
sudo ./scripts/install.sh   # one-time: installs Docker, creates .env
# edit .env: set ADMIN_USERNAME/ADMIN_PASSWORD and BASE_DOMAIN
./scripts/apply.sh          # builds and starts the stack; re-run anytime
```

Equivalently, by hand:

```bash
cp .env.example .env
# edit .env: set ADMIN_USERNAME/ADMIN_PASSWORD, a real SESSION_SECRET
# (see the comment in .env.example for how to generate one), and BASE_DOMAIN
# to match your wildcard DNS.

docker compose up -d --build
```

The manager's port is published on `127.0.0.1` only by default
(`MANAGER_BIND` in `.env`), since it speaks plain HTTP. From another machine,
tunnel to it (`ssh -L 8080:localhost:8080 <host>`, then open
`http://localhost:8080`), put a TLS reverse proxy in front (set `TRUST_PROXY`),
or — on a trusted network only — set `MANAGER_BIND=0.0.0.0` and re-run
`apply.sh`. Log in with the admin credentials from `.env`.
**Change the password immediately** (Settings page) — `.env` is only used to
seed the very first account.

## Deploying a modpack

1. Dashboard → **New Instance**.
2. Search for an FTB modpack by name and pick it.
3. Pick a specific server-file version. Every version has its own required
   Java runtime baked into FTB's own metadata — the app resolves this
   automatically and picks a matching `itzg/minecraft-server` image tag for
   you (see `docs/ARCHITECTURE.md` for why this matters: several older Forge
   packs will not boot at all on the wrong Java version, and this was
   confirmed the hard way during development).
4. Give it a display name, a subdomain (just the label, e.g. `pack1` — the
   base domain is appended for you), and a memory limit.
5. Deploy. The instance starts in `installing` status — large/old modpacks
   can take anywhere from under a minute to several minutes to first boot
   depending on pack size and your bandwidth. Watch the live console on the
   instance's detail page.
6. Once it's `running`, players connect with the **normal Minecraft port**
   or the exact subdomain, e.g. `pack1.mc.example.com` — no custom port
   needed, no matter how many other packs are also running.

If an instance lands in `error` status, the detail page shows the actual
tail of the container's own logs — that's almost always enough to tell you
what went wrong (most commonly: this specific pack's Java target isn't one
of the known image tags, or the pack itself has a broken FTB server-file
entry).

## Managing access

Only a **superadmin** can create/delete instances, manage users, and grant
access. Everything else needs per-instance access:

- Users page → add a user → grant them **operator** (start/stop/restart,
  console) or **admin** (also delete, edit subdomain) on specific instances.
- A user with no grants on an instance can't see it at all — the dashboard
  only ever shows what you have access to.

## Live console

Instance detail page → Console. This is a real, live connection: it tails
the container's stdout/stderr and lets you send server commands (e.g. `list`,
`say hello`, `whitelist add ...`) via RCON, without needing `docker exec` or
SSH access to the host.

## Logs on disk

Two places, both plain text under the repo's `logs/` directory (a real host
folder, not a Docker volume — open it directly):

- `logs/app.log` — the manager's own activity (logins, instance lifecycle
  events, errors).
- `logs/instances/<instanceId>/console.log` — that instance's full console
  history, independent of whatever's currently visible in the live UI
  console tab.

## Backing up / removing a modpack

Deleting an instance asks whether to also delete its world data. If you say
no, the underlying Docker volume (`mc-data-<instanceId>`) is left alone —
you can find it with `docker volume ls` and back it up with `docker run
--rm -v mc-data-<id>:/data -v $(pwd):/backup alpine tar czf /backup/<id>.tgz /data`
or similar, even after the instance no longer shows up in the UI.

## Known limitations (see docs/ARCHITECTURE.md for the full detail)

- The manager needs `/var/run/docker.sock`, which is root-equivalent host
  access — don't expose its port to the open internet without your own
  auth/VPN/TLS layer in front.
- Sessions are in-memory: restarting the manager container logs everyone out.
- FTB's catalog API is unofficial/community-documented and could change.
