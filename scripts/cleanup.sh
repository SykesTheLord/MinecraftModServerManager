#!/usr/bin/env bash
# Wipes this installation back to a fresh state, keeping only .env (and the
# code). Afterwards ./scripts/apply.sh starts it again as if newly installed:
# an empty database, with the admin seeded from .env.
#
#   ./scripts/cleanup.sh             list what would be deleted, then ask you to type "wipe"
#   ./scripts/cleanup.sh --dry-run   only list what would be deleted
#   ./scripts/cleanup.sh --yes       don't ask (for automation)
#
# Deletes, permanently:
#   - every modpack server container, and every helper container (installs,
#     backups) — anything labelled mcmgr.managed=true
#   - every server's data volume (mc-data-<id>): worlds, configs, mods, and
#     the world backups kept inside it
#   - the manager and infrared containers, the manager's database volume
#     (users, servers, settings, staged imports) and the mc-net network
#   - logs/ (except logs/.gitkeep), infrared/configs/, and the database
#     backups update.sh made in backups/
#
# Keeps: .env, the code, and downloaded Docker images (the next start reuses them).

set -euo pipefail

log() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

dry_run=false
assume_yes=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --yes) assume_yes=true ;;
    -h|--help) usage ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
docker info >/dev/null 2>&1 || die "can't talk to the Docker daemon (are you in the docker group, or running with sudo?)"
[ -f docker-compose.yml ] || die "docker-compose.yml not found in $REPO_ROOT"

# ---- What's there ----------------------------------------------------------

server_containers="$(docker ps -a --filter label=mcmgr.managed=true --format '{{.Names}}' | sort)"
# Volumes created since they were labelled, plus older ones by their exact name pattern.
server_volumes="$({
  docker volume ls -q --filter label=mcmgr.managed=true
  docker volume ls -q | grep -E '^mc-data-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || true
} | sort -u)"
stack_containers="$(docker compose ps -a --format '{{.Name}}' 2>/dev/null | sort || true)"
project="$(docker compose config --format json 2>/dev/null | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1)"
manager_volume=""
if [ -n "$project" ] && docker volume inspect "${project}_manager-data" >/dev/null 2>&1; then
  manager_volume="${project}_manager-data"
fi
network=""
docker network inspect mc-net >/dev/null 2>&1 && network="mc-net"

dir_contents() { [ -d "$1" ] && find "$1" -mindepth 1 -maxdepth 1 ! -name .gitkeep | head -n 1; }
local_dirs=()
[ -n "$(dir_contents logs)" ] && local_dirs+=("logs/ (manager and server console logs)")
[ -n "$(dir_contents infrared/configs)" ] && local_dirs+=("infrared/configs/ (routes)")
[ -n "$(dir_contents backups)" ] && local_dirs+=("backups/ (database backups made by update.sh)")

list() { # title, newline-separated items
  [ -n "$2" ] || return 0
  printf '\n%s\n' "$1"
  printf '%s\n' "$2" | sed 's/^/  - /'
}

printf 'This wipes the installation in %s, keeping only .env.\n' "$REPO_ROOT"
list "Modpack server and helper containers:" "$server_containers"
list "Server data volumes (worlds, configs, in-volume world backups):" "$server_volumes"
list "Stack containers:" "$stack_containers"
list "Manager database volume (users, servers, settings, staged imports):" "$manager_volume"
list "Network:" "$network"
list "Files on this host:" "$(printf '%s\n' "${local_dirs[@]+"${local_dirs[@]}"}")"

if [ -z "$server_containers$server_volumes$stack_containers$manager_volume$network" ] && [ ${#local_dirs[@]} -eq 0 ]; then
  printf '\nNothing to wipe — this installation is already clean.\n'
  exit 0
fi

if $dry_run; then
  printf '\n(dry run: nothing was deleted)\n'
  exit 0
fi

if ! $assume_yes; then
  printf '\nThis is permanent: every world on these servers is deleted, with no backup kept.\n'
  printf 'Type "wipe" to continue: '
  read -r answer
  [ "$answer" = "wipe" ] || die "not confirmed — nothing was deleted"
fi

# ---- Wipe ------------------------------------------------------------------

if [ -n "$server_containers" ]; then
  log "Removing modpack server and helper containers"
  # shellcheck disable=SC2086 # one name per word
  docker rm -f $server_containers >/dev/null
fi

# logs/ and infrared/configs/ hold files the containers wrote as root. Delete them from inside a
# throwaway container of the manager's own image (it runs as root) so this works without sudo —
# plain `docker run`, not `docker compose run`, which would recreate the volume and network this
# script removes (and build the image if it's missing). Falls back to a plain rm.
wipe_host_dirs() {
  local script='find /w/logs -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} + && find /w/infrared-configs -mindepth 1 -delete'
  mkdir -p logs infrared/configs
  if [ -n "$project" ] && docker image inspect "${project}-manager" >/dev/null 2>&1 &&
    docker run --rm --user 0 --network none \
      -v "$REPO_ROOT/logs:/w/logs" -v "$REPO_ROOT/infrared/configs:/w/infrared-configs" \
      --entrypoint sh "${project}-manager" -c "$script" >/dev/null 2>&1; then
    return 0
  fi
  find logs -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} + 2>/dev/null &&
    find infrared/configs -mindepth 1 -delete 2>/dev/null
}

log "Removing the manager and infrared, the manager's database and the mc-net network"
docker compose down --volumes --remove-orphans

if [ -n "$server_volumes" ]; then
  log "Removing server data volumes"
  # shellcheck disable=SC2086
  docker volume rm $server_volumes >/dev/null
fi

if docker network inspect mc-net >/dev/null 2>&1; then
  docker network rm mc-net >/dev/null 2>&1 || printf 'warning: mc-net is still in use by a container this script did not create; left in place\n' >&2
fi

# After the stack is down: infrared exits if its config folder is ever empty while it runs.
log "Clearing logs/, infrared/configs/ and backups/"
wipe_host_dirs || die "couldn't delete some files in logs/ or infrared/configs/ (owned by root) — re-run with sudo"
rm -rf backups

log "Done"
cat <<EOF
Everything except .env has been wiped. Start fresh with:

  ./scripts/apply.sh

The admin account from .env (ADMIN_USERNAME / ADMIN_PASSWORD) is created again on first start.
EOF
