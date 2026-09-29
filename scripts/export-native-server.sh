#!/usr/bin/env bash
# Packages a natively run Minecraft server directory into a .tar.gz for the
# manager's "Import Server" → "Upload an archive" option. Run it on the machine
# the server lives on (no dependencies beyond tar/gzip, which every Ubuntu
# install has), then copy the archive to wherever your browser is, e.g.:
#
#   ./export-native-server.sh /opt/minecraft/server
#   scp oldhost:~/minecraft-server-export.tar.gz .
#
# If the manager can reach the old machine over SSH, you don't need this at
# all: "Copy from another machine (SSH)" in the UI does the same thing
# directly.
#
# Refuses to run while a Java process is running from that directory (copying
# a live world can capture it mid-save) unless --force is given.

set -euo pipefail

usage() {
  echo "Usage: $0 [--include-backups] [--force] <server-dir> [output.tar.gz]" >&2
  exit 2
}

include_backups=false
force=false
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-backups) include_backups=true ;;
    --force) force=true ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *) args+=("$1") ;;
  esac
  shift
done
[[ ${#args[@]} -ge 1 && ${#args[@]} -le 2 ]] || usage

server_dir=$(realpath "${args[0]}")
output=$(realpath -m "${args[1]:-$HOME/minecraft-server-export.tar.gz}")

if [[ ! -d $server_dir ]]; then
  echo "Not a directory: $server_dir" >&2
  exit 1
fi
if [[ ! -f $server_dir/server.properties ]]; then
  echo "Warning: no server.properties in $server_dir — is this the server's directory?" >&2
fi
if [[ $output == "$server_dir"/* ]]; then
  echo "Write the archive outside the server directory (it would include itself)." >&2
  exit 1
fi

if ! $force; then
  for proc in /proc/[0-9]*; do
    cwd=$(readlink "$proc/cwd" 2>/dev/null) || continue
    comm=$(cat "$proc/comm" 2>/dev/null) || continue
    if [[ $comm == java* && $cwd == "$server_dir" ]]; then
      echo "A Java process (pid ${proc#/proc/}) is running in $server_dir — stop the server first" >&2
      echo "(e.g. 'sudo systemctl stop <your-minecraft-unit>'), or pass --force to copy it anyway." >&2
      exit 1
    fi
  done
fi

excludes=(--exclude=./logs --exclude=./crash-reports)
$include_backups || excludes+=(--exclude=./backups)

echo "Packaging $server_dir → $output"
tar -C "$server_dir" "${excludes[@]}" -czf "$output" .
echo "Done: $(du -h "$output" | cut -f1). Upload it in the manager under Import Server → Upload an archive."
