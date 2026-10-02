#!/usr/bin/env bash
# Updates this installation of the manager to a newer version from git, with
# a database backup and a one-command rollback.
#
#   ./scripts/update.sh                  update to the latest commit of the current branch
#   ./scripts/update.sh --check          only report whether an update is available
#   ./scripts/update.sh --ref v1.2.0     update (or move) to a specific tag, branch or commit
#   ./scripts/update.sh --rollback backups/<timestamp>
#                                        go back to the code + database saved by an earlier update
#   --force                              update even while a modpack install/backup is running
#
# What an update does:
#   1. git fetch; works out the target commit (fast-forward only for branches)
#   2. refuses if tracked files have local changes, or (without --force) if a
#      CurseForge install or pre-update world backup is in progress — those
#      run under the manager and would be interrupted by its restart
#   3. stops the manager and copies its SQLite database to backups/<timestamp>/
#      (with the commit it belonged to), keeping the newest 10 backups
#   4. moves the checkout to the target and runs scripts/apply.sh, which
#      rebuilds the manager image (database migrations run on its first start)
#   5. waits for the manager to report healthy; if it doesn't, prints its logs
#      and the rollback command
#
# Modpack servers keep running throughout (they aren't part of the compose
# stack); the manager re-attaches to them on start. Everyone is logged out
# (sessions are in memory), and unfinished imports must be started again.

set -euo pipefail

log() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

mode=update
ref=""
force=false
rollback_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --ref) [ $# -ge 2 ] || usage; ref="$2"; shift ;;
    --rollback) [ $# -ge 2 ] || usage; mode=rollback; rollback_dir="${2%/}"; shift ;;
    --force) force=true ;;
    -h|--help) usage ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage ;;
  esac
  shift
done

command -v git >/dev/null 2>&1 || die "git not found"
git rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_ROOT isn't a git checkout — updates need one (git clone the repository)"
command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found"
[ -f .env ] || die ".env not found — this doesn't look like an installed stack (see scripts/install.sh)"

DB_DIR=/app/data # inside the manager container (the manager-data volume)

require_clean_tree() {
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no >&2
    die "tracked files have local changes — commit or stash them first (nothing was changed)"
  fi
}

require_idle() {
  $force && return 0
  local busy
  busy="$(docker ps --filter label=mcmgr.role --format '{{.Names}}' || true)"
  if [ -n "$busy" ]; then
    die "a modpack install or pre-update backup is running ($busy) — restarting the manager now would interrupt it. Try again when it's done, or use --force."
  fi
}

# Runs a throwaway container from the manager's own image with its data volume mounted.
with_manager_data() {
  docker compose run --rm --no-deps -T "$@"
}

wait_healthy() {
  log "Waiting for the manager to come up"
  for _ in $(seq 1 45); do
    if docker compose exec -T manager node -e \
      "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

current="$(git rev-parse HEAD)"
branch="$(git symbolic-ref --short -q HEAD || true)"

if [ "$mode" = rollback ]; then
  [ -f "$rollback_dir/COMMIT" ] && [ -f "$rollback_dir/app.sqlite3" ] \
    || die "$rollback_dir isn't a backup made by this script (expected COMMIT and app.sqlite3 in it)"
  target="$(cat "$rollback_dir/COMMIT")"
  git cat-file -e "${target}^{commit}" 2>/dev/null || die "commit $target from the backup isn't in this checkout"
  require_clean_tree

  log "Rolling back to $(git log -1 --format='%h %s' "$target") with the database from $rollback_dir"
  if [ -n "$branch" ]; then
    git reset --keep "$target"
  else
    git checkout --detach "$target"
  fi
  docker compose build manager
  docker compose stop manager
  # Replace the database files exactly (a leftover -wal from the newer
  # version would otherwise be replayed onto the restored database).
  with_manager_data --user 0 -v "$REPO_ROOT/$rollback_dir:/restore:ro" --entrypoint sh manager -c \
    "rm -f $DB_DIR/app.sqlite3 $DB_DIR/app.sqlite3-wal $DB_DIR/app.sqlite3-shm && cp /restore/app.sqlite3* $DB_DIR/"
  ./scripts/apply.sh
  wait_healthy || die "the manager didn't come up after the rollback — see: docker compose logs manager"
  log "Rolled back to $(git rev-parse --short HEAD)"
  exit 0
fi

log "Fetching updates"
git fetch --tags --quiet origin

if [ -n "$ref" ]; then
  target="$(git rev-parse --verify --quiet "origin/$ref^{commit}" || git rev-parse --verify --quiet "$ref^{commit}" || true)"
  [ -n "$target" ] || die "unknown tag, branch or commit: $ref"
else
  [ -n "$branch" ] || die "not on a branch (detached HEAD) — use --ref <branch|tag> to choose what to update to"
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  [ -n "$upstream" ] || die "branch $branch has no upstream — use --ref, or: git branch --set-upstream-to=origin/$branch"
  target="$(git rev-parse "$upstream")"
fi

if [ "$target" = "$current" ]; then
  echo "Already up to date ($(git log -1 --format='%h %s' HEAD))."
  exit 0
fi

if [ -z "$ref" ] && ! git merge-base --is-ancestor "$current" "$target"; then
  die "$branch has commits that aren't upstream (diverged) — resolve that by hand, or use --ref"
fi

log "Changes from $(git rev-parse --short "$current") to $(git rev-parse --short "$target")"
if git merge-base --is-ancestor "$current" "$target"; then
  git --no-pager log --oneline --no-decorate "$current..$target"
else
  echo "(not a fast-forward: moving to a different line of history)"
fi

if [ "$mode" = check ]; then
  echo
  echo "Run ./scripts/update.sh${ref:+ --ref $ref} to install."
  exit 0
fi

require_clean_tree
require_idle

backup_dir="backups/$(date +%Y%m%d-%H%M%S)"
log "Backing up the database to $backup_dir"
mkdir -p "$backup_dir"
echo "$current" > "$backup_dir/COMMIT"
docker compose stop manager
# Copy as the invoking user so the backup isn't root-owned.
with_manager_data --user "$(id -u):$(id -g)" -v "$REPO_ROOT/$backup_dir:/backup" --entrypoint sh manager -c \
  "cp $DB_DIR/app.sqlite3* /backup/" || {
  docker compose start manager >/dev/null
  die "couldn't back up the database — nothing was changed (manager restarted)"
}
# Keep the newest 10 backups.
find backups -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | sort | head -n -10 | xargs -r rm -rf

log "Moving to $(git rev-parse --short "$target")"
if [ -z "$ref" ]; then
  git merge --ff-only --quiet "$target"
elif [ -n "$branch" ] && git show-ref --verify --quiet "refs/remotes/origin/$ref"; then
  git checkout --quiet "$ref" 2>/dev/null || git checkout --quiet -b "$ref" --track "origin/$ref"
  git merge --ff-only --quiet "$target"
else
  git checkout --quiet --detach "$target"
fi

./scripts/apply.sh

if ! wait_healthy; then
  docker compose logs --tail 40 manager >&2 || true
  die "the manager didn't report healthy after updating. To go back: ./scripts/update.sh --rollback $backup_dir"
fi

log "Updated to $(git log -1 --format='%h %s' HEAD)"
echo "Database backup: $backup_dir  (undo with: ./scripts/update.sh --rollback $backup_dir)"
