#!/usr/bin/env bash
# Build all production images for the AI Document Intelligence Platform.
#
# Usage:
#   ./infra/scripts/build-images.sh [registry] [tag]
#
# Examples:
#   ./infra/scripts/build-images.sh                        # ai-platform/*:latest
#   ./infra/scripts/build-images.sh ghcr.io/fiwon123 0.1.0 # ghcr.io/fiwon123/backend:0.1.0
#
# NOTE: this script uses Docker and must be run on the host (or CI), NOT
# inside the dev container (no docker binary there).

set -euo pipefail

REGISTRY="${1:-ai-platform}"
TAG="${2:-latest}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKER_DIR="${ROOT_DIR}/infra/docker"

image() {
  local name="$1"
  shift
  echo "==> Building ${REGISTRY}/${name}:${TAG}"
  docker build "$@" \
    -f "${DOCKER_DIR}/Dockerfile.${name}" \
    -t "${REGISTRY}/${name}:${TAG}" \
    "${ROOT_DIR}/${name}"
}

image backend
image worker
image frontend

echo "==> Done. Images:"
for img in backend worker frontend; do
  echo "  - ${REGISTRY}/${img}:${TAG}"
done