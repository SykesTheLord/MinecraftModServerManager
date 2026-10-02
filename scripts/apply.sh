#!/usr/bin/env bash
# Brings the docker-compose stack (manager + infrared) up to match the
# current docker-compose.yml/.env — safe to re-run any time (after a git
# pull, a .env edit, etc.): rebuilds the manager image only if it changed,
# pulls infrared if missing, and recreates only the containers that need it.
# This is the "desired state" counterpart to scripts/install.sh, which only
# prepares the host and is not re-run on every deploy.
#
# Usage: ./scripts/apply.sh

set -euo pipefail

log() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v docker >/dev/null 2>&1 || die "docker not found — run scripts/install.sh first"
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found — run scripts/install.sh first"
[ -f .env ] || die ".env not found — run scripts/install.sh, or 'cp .env.example .env' and edit it"

if grep -q '^SESSION_SECRET=replace-with-a-long-random-string$' .env 2>/dev/null; then
  die "SESSION_SECRET in .env is still the placeholder value — set a real random secret before deploying (see the comment above it in .env)"
fi

# .env holds the session secret and admin password; keep it owner-only.
chmod 600 .env 2>/dev/null || true

# Stamp the image with the commit it's built from (shown in Settings → About).
APP_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$APP_COMMIT" != unknown ] && [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  APP_COMMIT="${APP_COMMIT}-modified"
fi
export APP_COMMIT

log "Building/pulling and starting the stack (commit ${APP_COMMIT})"
docker compose up -d --build

log "Current status"
docker compose ps

MANAGER_PORT="$(grep -E '^MANAGER_PORT=' .env | cut -d= -f2- || true)"
BASE_DOMAIN="$(grep -E '^BASE_DOMAIN=' .env | cut -d= -f2- || true)"
MANAGER_BIND="$(grep -E '^MANAGER_BIND=' .env | cut -d= -f2- || true)"

cat <<EOF

Manager UI: http://${MANAGER_BIND:-127.0.0.1}:${MANAGER_PORT:-8080}
Minecraft port (all modpacks share this): 25565

Reminder: wildcard DNS for *.${BASE_DOMAIN:-your-base-domain} must already
point at this host for subdomain routing to work — this app does not manage
DNS.
EOF
