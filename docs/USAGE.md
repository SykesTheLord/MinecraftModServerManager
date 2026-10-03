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

Dashboard → **+ New server**, then:

1. **Choose a modpack.** Two catalogs, as tabs:
   - **Feed The Beast** — the *entire* FTB catalog is listed (it's ~90
     packs), with artwork, Minecraft version, loader and install counts.
     Filter by name/tag/description, narrow to a Minecraft version, sort by
     popularity, name or last update.
   - **CurseForge** — tens of thousands of packs, so it's a live search:
     type to search, filter by Minecraft version and mod loader, sort, and
     **Load more** to page further. Needs a CurseForge API key — see below.
2. **Pick a version.** Newest first, with its Minecraft version, loader,
   date and release/beta/alpha tag. The right Java runtime is resolved
   automatically — from FTB's own metadata for FTB packs, from the Minecraft
   version for CurseForge (overridable on the next step). Several older Forge
   packs will not boot at all on the wrong Java version; see
   `docs/ARCHITECTURE.md`.
3. **Configure & deploy.** Name and subdomain are pre-filled from the pack
   (the subdomain is just the label, e.g. `stoneblock` — the base domain is
   appended), memory defaults to the pack's recommendation where FTB gives
   one.

The server starts in `Creating`/`Starting` status — big packs can take
several minutes to download and first boot. Watch the console (or, for
CurseForge, the install log) on its page. Once it's `Running`, players
connect on the **normal Minecraft port** with the server's address, e.g.
`stoneblock.mc.example.com`, however many other servers are running.

If a server lands in `Error`, its page shows the real tail of its logs —
usually enough to tell what went wrong (most commonly a Java version the
pack doesn't run on, or a broken server-file entry upstream).

### CurseForge

CurseForge's API needs a key. Get a free one at
<https://console.curseforge.com/>, put it in `.env` as `CF_API_KEY=…`, and
re-run `./scripts/apply.sh`. Until then the CurseForge tab explains this
and the rest of the app works as before.

The key is yours and is governed by CurseForge's
[3rd-party API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curse-forge-3rd-party-api-terms-and-conditions).
In practice: don't share it or reuse someone else's, and don't route the
manager's traffic through a proxy or VPN to reach the API.

**Caching, against the terms.** The terms also forbid caching API data. The
manager caches anyway, so it stays under CurseForge's request limit for your
key:
- The manager keeps responses in memory: searches for 30 minutes, version
  lists for 12 hours, pack details for an hour, and file details for 6
  hours. Its restart clears them.
- Version lists have a **Force refresh** button (on the new-server version
  step, and on a server's Updates tab next to **Check now** and above
  **Other versions**). Clicking it fetches the list from CurseForge right
  away. Repeated clicks within a minute reuse that fresh copy. Scheduled
  update checks use the cache, so they notice a new CurseForge release
  within about 12 hours.
- Your browser reuses results for 5 minutes.
- The installer keeps its own cache in each server's volume.

That's a deliberate choice, and the risk to your key is yours. If CurseForge
limits your key anyway, the manager says so instead of failing vaguely.

The key stays with the manager: each pack is downloaded and installed by a
separate, short-lived container that is removed straight afterwards, and
the server itself runs without the key, so a mod can't read it.

**Mods that can't be downloaded automatically.** Some mod authors only
allow downloads from CurseForge's website. When a pack includes one, the
server goes to **Needs files** and its page lists each file with a
**Download** link (to that exact file on CurseForge) and an **Upload file**
button. Download each one in your browser and upload it; every upload is
checked against CurseForge's own checksum, so only the exact file is
accepted. Then click **Continue install**. Mods already downloaded stay in
the server's volume, so continuing is quick. The file names and links are
looked up on CurseForge (through the manager's cache) rather than stored.

## Importing an existing server

Dashboard → **Import Server** brings over a Minecraft server that has been
running natively — typically a Forge/NeoForge/Fabric/Quilt/Paper/vanilla
server run with `java -jar` or a `run.sh` on an Ubuntu box. Its mods,
configs, world, whitelist/ops etc. are copied into a new instance's volume;
from then on it's a normal instance (subdomain routing, console, access
grants, start/stop).

**Stop the server on the old machine first.** Copying a running server can
capture its world mid-save.

**Imports run in the background.** Each import has its own page
(`/instances/import/<id>`), and both the import page and the dashboard list
imports in progress or waiting for review. The parts that run on the
manager keep going if you leave the page or close the browser: the SSH
copy, unpacking and analysis, and the final deploy, which copies the files
into the new server. An archive upload is sent by your browser, so it
continues while you use the rest of the app, but only as long as that tab
stays open. The browser asks before you close it mid-upload. Imports that
nobody touches for a day are dropped, as is anything in progress when the
manager restarts.

Two ways to get the files over:

- **Copy from another machine (SSH)** — the manager connects to the old
  machine and streams the server directory with `tar` (no setup needed on
  that machine beyond a running `sshd`, which Ubuntu servers have).
  1. Enter its host/port and click **Check host key**. Compare the
     fingerprint shown against the one printed by running the displayed
     `ssh-keygen -lf …` command *on the old machine itself*, and only tick
     "matches" if they're identical — the transfer refuses any other key.
  2. Log in, then give the server's absolute directory (e.g.
     `/opt/minecraft/server`). There are three ways to log in:
     - **This host's SSH key** is the default when available. These are the
       SSH keys of the user who runs the manager (`~/.ssh`), so if you can
       already `ssh` from this host to the old machine, nothing else is
       needed. Pick the key, and enter its passphrase if it has one. If the
       old machine doesn't accept the key yet, open **Not set up on the old
       machine yet?** and add the public key shown there to the SSH user's
       `~/.ssh/authorized_keys`.
     - A **password**.
     - **Paste a private key**, for a key that isn't on this host.
  3. If the files belong to a separate service account (e.g. `minecraft`),
     tick **Read the files with sudo** — that needs passwordless sudo for
     `tar` for the SSH user, e.g. a sudoers line
     `youruser ALL=(ALL) NOPASSWD: /usr/bin/tar`.
  Credentials are held in memory only for the transfer and never stored.
  The manager container needs to be able to reach the old machine's SSH port.

  **How the host's keys reach the manager.** `scripts/apply.sh`, which
  `update.sh` also runs, shares the `~/.ssh` of the user running it (under
  `sudo`, the user who ran `sudo`) with the manager, **read-only**. To share
  a different folder, set `SSH_KEYS_DIR=/path` in `.env`. To share none, set
  it empty (`SSH_KEYS_DIR=`). Private keys never leave the manager; your
  browser only ever sees key names, fingerprints and public keys. If you
  start the stack with `docker compose up` directly instead of `apply.sh`,
  nothing is shared unless `.env` sets `SSH_KEYS_DIR`.
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

## Editing server.properties

Server page → **Server properties** tab (server admins). Every property
is listed with a short explanation for the common ones and dropdowns for
fixed choices (difficulty, game mode, true/false…). You can filter, edit,
add or remove properties, then **Save**, or **Save & restart** if the server
is running. Minecraft only reads the file at startup, so changes take effect
after a restart. Comments and ordering in the file are kept, and values you
didn't touch are written back exactly as they were.

A few properties are read-only, each with the reason shown next to it:
`server-port`/`server-ip`, because the shared proxy needs every server on
25565 on all interfaces; the RCON settings, which the console depends on; and,
for imported or CurseForge servers, `level-name`, which their configuration
sets on every start. If the file changed after you opened it (Minecraft
rewrites it when it starts), saving is refused rather than overwriting
those changes. Reload and redo your edit.

## Modpack updates

FTB and CurseForge servers have an **Updates** tab (server admins):

- **Installed version**, the **latest update** found, and **Check now**.
- **Automatic updates**, per server:
  - **Off** — never check.
  - **Notify** (default) — check every `PACK_UPDATE_CHECK_HOURS` (6 by
    default) and show "Update available" on the dashboard and the server.
  - **Automatic** — also install it, but only when all of these hold:
    it's a *release* (not beta/alpha), it's for the *same Minecraft version*
    as what's installed, and the server is *running with nobody online*
    (checked over RCON). A busy server is retried every 15 minutes, and a
    stopped server is left alone.
- **Other versions** — switch to any version, older or newer, including
  across Minecraft versions. You're warned when the Minecraft version
  changes, because worlds often can't go back to an older one.

**Update window.** With **Automatic** selected you can also restrict
installs to a daily time window, e.g. 22:00–06:00 for overnight. The window
can cross midnight, and it's evaluated in a time zone you choose, which
defaults to your browser's (the manager itself runs in UTC). Outside the
window a pending update just waits, and the page says so. Checking for
updates still happens at any time.

Every update, automatic or manual, first stops the server and takes a
backup (see below), then installs the new version into the same volume, so
the world carries over. For CurseForge packs, a mod that needs a manual
download sends the server to **Needs files** as on first install.

## Backups and restoring

Server page → **Backups** tab (server admins, every kind of server). Each
backup holds the world, configs, `server.properties` and player data. Mods
and libraries are left out because they're re-downloaded. Backups live
inside the server's own volume (`.update-backups/`), and the newest **5** are
kept.

- A backup is made **automatically before every update and every restore**.
- **Back up now** makes one on demand. A running server keeps running:
  saving is paused (`save-off`, `save-all flush`) for the moment the
  archive takes, then turned back on.
- **Restore…** replaces the world and configs with a backup's. The server
  stops, its current state is backed up first (so a restore can be undone
  by restoring that one), the parts the backup contains are *removed and
  then* extracted (never mixed with the newer files), and the server starts
  again if it was running. Mods and libraries are left alone.
- If the backup was taken on a **different pack version** (e.g. one made
  before an update), the confirmation offers to **also switch the pack back
  to that version**. That's recommended, because the world was saved by
  that version's mods.

## Updating the manager itself

```bash
./scripts/update.sh --check   # what's new, without changing anything
./scripts/update.sh           # update to the latest commit of the current branch
./scripts/update.sh --ref v1.2.0          # or to a specific tag/branch/commit
./scripts/update.sh --rollback backups/<timestamp>   # undo an update
```

`update.sh` refuses to run while tracked files have local changes, or while a
CurseForge install or pre-update backup is running (`--force` overrides the
latter). It then:

1. stops the manager and copies its database to `backups/<timestamp>/`
   (along with the commit it belongs to), keeping the last 10;
2. fast-forwards the checkout and runs `apply.sh`, which rebuilds the image.
   Database migrations run when the new manager starts;
3. waits for the manager to report healthy. If it doesn't, it prints the
   manager's logs and the exact `--rollback` command.

Modpack servers keep running throughout. Everyone is logged out (sessions
live in memory), and an import that was in progress has to be started again.
**Settings → About** shows the running version and the commit it was built
from.

## Starting over (wiping an installation)

```bash
./scripts/cleanup.sh --dry-run   # list exactly what would be deleted
./scripts/cleanup.sh             # wipe it (asks you to type "wipe"; --yes skips that)
./scripts/apply.sh               # start again from scratch
```

`cleanup.sh` resets the installation to a fresh state and keeps only
`.env`, the code, and downloaded Docker images. It **permanently deletes**:

- every modpack server, including its world, configs and the world backups
  kept with it;
- the manager's database: users, servers and settings;
- `logs/`, the routing configs, and the database backups `update.sh` made in
  `backups/`.

Nothing is backed up first, so copy out any world you want to keep. On the
next start the admin account is created again from `ADMIN_USERNAME` /
`ADMIN_PASSWORD` in `.env`.

## Managing access

Only a **platform admin** (called `superadmin` in the code and API) can
create or import servers, manage users, and grant access. Everyone else
needs per-instance access.

To make someone a platform admin, tick **Platform admin** when adding them.
For an existing user, use **Make platform admin…** on their row of the
Users page, which asks you to confirm first. **Remove platform admin…**
turns them back into a regular user, keeping only the server access granted
to them. Either change applies to their very next request, including a
session that's already open. You can't change your own role, so there is
always at least one platform admin.

Per-instance access:

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
