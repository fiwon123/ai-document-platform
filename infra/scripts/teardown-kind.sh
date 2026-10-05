#!/usr/bin/env bash
# Delete the Kind cluster and the local registry container.
#
# Usage:
#   ./infra/scripts/teardown-kind.sh

set -euo pipefail

CLUSTER_NAME="ai-platform"
REGISTRY_NAME="kind-registry"

# Cluster removal needs kind; registry cleanup only needs docker.
if command -v kind >/dev/null 2>&1; then
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    echo "==> Deleting Kind cluster '${CLUSTER_NAME}'"
    kind delete cluster --name "${CLUSTER_NAME}"
  else
    echo "==> No Kind cluster '${CLUSTER_NAME}' to delete"
  fi
else
  echo "SKIP: 'kind' not installed — skipping cluster deletion"
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: 'docker' is required but not installed"; exit 1; }

if docker inspect "${REGISTRY_NAME}" >/dev/null 2>&1; then
  echo "==> Removing registry container '${REGISTRY_NAME}'"
  docker rm -f "${REGISTRY_NAME}" >/dev/null
  docker volume rm "${REGISTRY_NAME}" >/dev/null 2>&1 || echo "SKIP: volume '${REGISTRY_NAME}' already removed or in use"
else
  echo "==> No registry container '${REGISTRY_NAME}' to remove"
fi

echo "==> Done. Local Kind environment cleaned up."