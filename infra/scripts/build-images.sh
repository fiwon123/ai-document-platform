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
#
# BuildKit is requested explicitly rather than relied upon being the default.
# The two builders do not accept the same Dockerfiles: the legacy builder
# expands a variable in `COPY --from=<image>:${VAR}`, and BuildKit refuses it
# outright ("variable expansion is not supported for --from"). A local build on a
# Docker configured for the legacy builder therefore passes on a file that CI
# cannot build at all, which is exactly how #626 survived from #189 — see the
# `uv` stage in Dockerfile.backend for the other half of that fix.

set -euo pipefail

export DOCKER_BUILDKIT=1

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
# NOTE: minio has no build context of its own — Dockerfile.minio downloads a
# pinned, checksum-verified release binary — so the docker/ directory is enough.
image minio infra/docker

echo "==> Done. Images:"
for img in backend worker frontend minio; do
  echo "  - ${REGISTRY}/${img}:${TAG}"
done
