#!/usr/bin/env bash
# Installs the only real host prerequisite for this project — Docker Engine
# + the Compose plugin — on whichever major Linux distro this is running on,
# then does one-time repo setup (.env, logs/ dir). It does NOT start the app;
# run scripts/apply.sh for that once this finishes.
#
# Supported: Debian, Ubuntu (and derivatives reporting ID_LIKE=debian/ubuntu),
# Fedora, RHEL, CentOS, Rocky Linux, AlmaLinux (ID_LIKE=fedora/rhel),
# Arch Linux, Manjaro (ID_LIKE=arch), openSUSE (ID_LIKE=suse).
#
# Usage: sudo ./scripts/install.sh

set -euo pipefail

log() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must be run as root (try: sudo $0)"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The user who invoked sudo, so we can add *them* (not root) to the docker
# group and so any files we create in the repo end up owned by them.
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker + Compose plugin already installed, skipping install"
else
  [ -f /etc/os-release ] || die "cannot detect distro: /etc/os-release not found"
  # shellcheck source=/dev/null
  . /etc/os-release
  DISTRO_ID="${ID:-}"
  DISTRO_LIKE="${ID_LIKE:-}"

  log "Detected distro: ${PRETTY_NAME:-$DISTRO_ID} (id=$DISTRO_ID, like=$DISTRO_LIKE)"

  # Order matters: RHEL/CentOS/Rocky/Alma all declare ID_LIKE containing
  # "fedora" too, so the rhel/centos check must come before the fedora one
  # or they'd all wrongly match Fedora's (incompatible) repo URL.
  case "$DISTRO_ID $DISTRO_LIKE" in
    *debian*|*ubuntu*)
      log "Installing Docker via apt (Docker's official repo)"
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      ARCH="$(dpkg --print-architecture)"
      CODENAME="${VERSION_CODENAME:-$(lsb_release -cs)}"
      echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DISTRO_ID} ${CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *rhel*|*centos*)
      log "Installing Docker via dnf/yum (Docker's official CentOS repo, compatible with RHEL/Rocky/Alma)"
      if command -v dnf >/dev/null 2>&1; then
        dnf -y install dnf-plugins-core
        dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      else
        yum install -y yum-utils
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      fi
      ;;
    *fedora*)
      log "Installing Docker via dnf (Docker's official Fedora repo)"
      dnf -y install dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
      dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *arch*)
      log "Installing Docker via pacman"
      pacman -Sy --noconfirm --needed docker docker-compose
      ;;
    *suse*)
      log "Installing Docker via zypper"
      zypper --non-interactive install docker docker-compose
      ;;
    *)
      die "unsupported distro '$DISTRO_ID' (like: '$DISTRO_LIKE') — install Docker Engine + the Compose plugin manually, then re-run this script (it will detect Docker is present and skip to repo setup)"
      ;;
  esac

  log "Enabling and starting the docker service"
  systemctl enable --now docker

  if [ "$TARGET_USER" != "root" ]; then
    log "Adding $TARGET_USER to the docker group"
    usermod -aG docker "$TARGET_USER"
    echo "NOTE: log out and back in (or run 'newgrp docker') before running apply.sh without sudo."
  fi
fi

log "Setting up repo config"
cd "$REPO_ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  # Generate a real session secret instead of shipping with the .env.example
  # placeholder — that placeholder must never reach a real deployment.
  SECRET="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${SECRET}/" .env
  # Holds the session secret and admin password — owner-only.
  chmod 600 .env
  echo "Created .env with a generated SESSION_SECRET — edit it to set ADMIN_USERNAME, ADMIN_PASSWORD, and BASE_DOMAIN before running apply.sh."
else
  echo ".env already exists, leaving it as-is"
fi

mkdir -p logs
[ "$TARGET_USER" != "root" ] && chown -R "$TARGET_USER" .env logs 2>/dev/null || true

log "Install complete. Next: edit .env, then run scripts/apply.sh"
