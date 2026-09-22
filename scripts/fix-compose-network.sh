#!/usr/bin/env bash
#
# fix-compose-network.sh
#
# Detects compose containers that lost their project-network attachment —
# visible as `NetworkSettings.Networks: {}` in `docker inspect`. This is the
# root cause of the devcontainer failure:
#
#   psycopg2.OperationalError: could not translate host name "postgres" to
#   address: Name or service not known
#
# The Dev Containers CLI always runs `docker compose up -d --no-recreate`, so
# it never reconciles an existing container's network attachment — once a
# container ends up networkless, every reopen fails identically until the
# stack is recreated. This script detects and repairs that state.
#
# Run it on the HOST (where the docker CLI lives), from the repo root:
#
#   scripts/fix-compose-network.sh            # check only, print report
#   scripts/fix-compose-network.sh --repair   # check + recreate the stack
#
# NOTE: this script never uses `docker compose down -v` — named volumes
# (postgres data, uploads, venvs, ...) are preserved by `down`.

set -euo pipefail

# The project network every service must be attached to (pinned by name in
# docker-compose.yaml via the top-level networks block).
EXPECTED_NETWORK="ai-document-platform_default"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose.yaml}"

REPAIR=0
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: $0 [--repair]" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker CLI not found — this script must run on the host, not inside a container." >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "error: compose file not found: $COMPOSE_FILE (run from the repo root)" >&2
  exit 1
fi

echo "Checking project network attachment..."
echo "Compose file: $COMPOSE_FILE"

# IDs of every container in this compose project (running, stopped, or created).
PS_OUTPUT="$(docker compose -f "$COMPOSE_FILE" ps -aq 2>/dev/null || true)"
containers=()
if [[ -n "$PS_OUTPUT" ]]; then
  mapfile -t containers <<< "$PS_OUTPUT"
fi

if [[ "${#containers[@]}" -eq 0 ]]; then
  echo "No compose containers found — nothing to repair."
  exit 0
fi

detached=()
for id in "${containers[@]}"; do
  name="$(docker inspect --format '{{.Name}}' "$id")"
  name="${name#/}"
  networks="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$id")"
  if grep -qF "\"$EXPECTED_NETWORK\"" <<< "$networks"; then
    echo "  [ok]   $name"
  else
    echo "  [DETACHED] $name"
    detached+=("$name")
  fi
done

if [[ "${#detached[@]}" -eq 0 ]]; then
  echo
  echo "All containers are attached to \"$EXPECTED_NETWORK\" — nothing to repair."
  exit 0
fi

echo
echo "Detached containers: ${detached[*]}"
echo

if [[ "$REPAIR" -ne 1 ]]; then
  echo "Re-run with --repair to recreate the stack:"
  echo "  scripts/fix-compose-network.sh --repair"
  echo "(recreates postgres/redis/minio on a fresh network; volumes are preserved)"
  exit 1
fi

echo "Running: docker compose down (no -v — volumes preserved)"
docker compose -f "$COMPOSE_FILE" down

echo "Running: docker compose up -d postgres redis minio"
docker compose -f "$COMPOSE_FILE" up -d postgres redis minio

echo
echo "Repair complete. Reopen the dev container now"
echo "(Dev Containers: Reopen in Container)."