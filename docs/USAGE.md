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

## Importing an existing server

Dashboard → **Import Server** brings over a Minecraft server that has been
running natively — typically a Forge/NeoForge/Fabric/Quilt/Paper/vanilla
server run with `java -jar` or a `run.sh` on an Ubuntu box. Its mods,
configs, world, whitelist/ops etc. are copied into a new instance's volume;
from then on it's a normal instance (subdomain routing, console, access
grants, start/stop).

**Stop the server on the old machine first.** Copying a running server can
capture its world mid-save.

Two ways to get the files over:

- **Copy from another machine (SSH)** — the manager connects to the old
  machine and streams the server directory with `tar` (no setup needed on
  that machine beyond a running `sshd`, which Ubuntu servers have).
  1. Enter its host/port and click **Check host key**. Compare the
     fingerprint shown against the one printed by running the displayed
     `ssh-keygen -lf …` command *on the old machine itself*, and only tick
     "matches" if they're identical — the transfer refuses any other key.
  2. Log in with a password or a private key, and give the server's absolute
     directory (e.g. `/opt/minecraft/server`).
  3. If the files belong to a separate service account (e.g. `minecraft`),
     tick **Read the files with sudo** — that needs passwordless sudo for
     `tar` for the SSH user, e.g. a sudoers line
     `youruser ALL=(ALL) NOPASSWD: /usr/bin/tar`.
  Credentials are held in memory only for the transfer and never stored.
  The manager container needs to be able to reach the old machine's SSH port.
- **Upload an archive** — a `.tar.gz`, `.tar` or `.zip` of the server
  directory, uploaded from your browser (in chunks, so multi-GB servers are
  fine). On the old machine, `scripts/export-native-server.sh
  /opt/minecraft/server` makes one (it skips logs/backups and refuses to run
  while the server is still running); or just
  `tar -czf server.tar.gz -C /opt/minecraft/server .`.

`logs/` and `crash-reports/` are always dropped; `backups/` is skipped by
default. The manager then detects the platform, Minecraft and loader
versions, the heap size (`-Xmx` from the start script or
`user_jvm_args.txt`) and the world folder (`level-name`), and shows them for
review — correct anything it got wrong (unrecognized servers can run a jar
of your choice as a "Custom jar"). On **Deploy**, the container installs that
loader version itself on first boot (the old start scripts aren't used),
picks a Java version from the Minecraft version unless you override it, and
`server-port`/`server-ip` in `server.properties` are reset so the server is
reachable through the shared port 25565. Everything else in
`server.properties` is kept.

Imports that are never deployed are discarded after 24 hours (and on manager
restart). The largest importable server is 64 GiB by default
(`IMPORT_MAX_BYTES` in `.env`); staged files live in the manager's data
volume until deployed, so it needs that much free space temporarily.

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
- An import in progress is lost if the manager restarts (start it again).
