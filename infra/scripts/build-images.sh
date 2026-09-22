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
  local img="$1"
  local ctx="$2"
  shift 2
  echo "==> Building ${REGISTRY}/${img}:${TAG}"
  docker build "$@" \
    -f "${DOCKER_DIR}/Dockerfile.${img}" \
    -t "${REGISTRY}/${img}:${TAG}" \
    "${ROOT_DIR}/${ctx}"
}

# NOTE: worker reuses the backend source tree as its build context.
image backend backend
image worker backend
image frontend frontend

echo "==> Done. Images:"
for img in backend worker frontend; do
  echo "  - ${REGISTRY}/${img}:${TAG}"
done
