#!/usr/bin/env bash
# Build all production images and push them to the local Kind registry
# (which the cluster is configured to pull from via containerd mirrors).
#
# Usage:
#   ./infra/scripts/kind-load-images.sh
#
# Requires: Kind cluster up (see setup-kind.sh), Docker on the host.

set -euo pipefail

REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5000"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build images tagged for the local registry.
"${SCRIPT_DIR}/build-images.sh" "localhost:${REGISTRY_PORT}" latest

# Push them so the cluster nodes can pull from http://kind-registry:5000
# (the containerd mirror configured in kind-config.yaml).
for img in backend worker frontend; do
  echo "==> Pushing localhost:${REGISTRY_PORT}/${img}:latest to local registry"
  docker push "localhost:${REGISTRY_PORT}/${img}:latest"
done

echo "==> Done. Cluster can pull images as localhost:5000/*:latest"