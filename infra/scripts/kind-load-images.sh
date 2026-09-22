#!/usr/bin/env bash
# Build all production images and push them to the local Kind registry
# (which the cluster is configured to pull from via containerd mirrors).
#
# Usage:
#   ./infra/scripts/kind-load-images.sh
#
# Requires: Kind cluster up (see setup-kind.sh), Docker on the host.

set -euo pipefail

CLUSTER_NAME="ai-platform"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5000"

command -v docker >/dev/null 2>&1 || { echo "ERROR: 'docker' is required but not installed"; exit 1; }
command -v kind >/dev/null 2>&1 || { echo "ERROR: 'kind' is required but not installed"; exit 1; }

# Preflight: registry and cluster must exist.
docker inspect "${REGISTRY_NAME}" >/dev/null 2>&1 \
  || { echo "ERROR: registry '${REGISTRY_NAME}' not found — run infra/scripts/setup-kind.sh first"; exit 1; }
kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$" \
  || { echo "ERROR: Kind cluster '${CLUSTER_NAME}' not found — run infra/scripts/setup-kind.sh first"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build images tagged for the local registry.
"${SCRIPT_DIR}/build-images.sh" "localhost:${REGISTRY_PORT}" latest

# Push them so cluster nodes can pull from http://kind-registry:5000
# (the containerd mirror configured in kind-config.yaml).
# Deployments must reference images as localhost:5000/<name>:latest and set
# imagePullPolicy: IfNotPresent.
for img in backend worker frontend; do
  echo "==> Pushing localhost:${REGISTRY_PORT}/${img}:latest to local registry"
  docker push "localhost:${REGISTRY_PORT}/${img}:latest"
done

echo "==> Done. Cluster can pull images as localhost:5000/*:latest"