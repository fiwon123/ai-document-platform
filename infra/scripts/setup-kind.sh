#!/usr/bin/env bash
# Create a Kind cluster with a local container registry for image loading.
#
# Usage:
#   ./infra/scripts/setup-kind.sh
#
# Creates:
#   - a Kind cluster named "ai-platform"
#   - a local registry container "kind-registry" on 127.0.0.1:5000
#
# run on the host (or CI) — NOT inside the dev container (no kind binary there).

set -euo pipefail

CLUSTER_NAME="ai-platform"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5000"

command -v kind >/dev/null 2>&1 || { echo "ERROR: 'kind' is required but not installed"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: 'docker' is required but not installed"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIND_CONFIG="${SCRIPT_DIR}/../kind/kind-config.yaml"

# 1. Local registry
if [ "$(docker inspect -f '{{.State.Running}}' "${REGISTRY_NAME}" 2>/dev/null || true)" != "true" ]; then
  if [ "$(docker volume inspect "${REGISTRY_NAME}" >/dev/null 2>&1 && echo exists || echo missing)" = "missing" ]; then
    docker volume create "${REGISTRY_NAME}" >/dev/null
  fi
  echo "==> Starting local registry container '${REGISTRY_NAME}'"
  docker run -d \
    --name "${REGISTRY_NAME}" \
    -v "${REGISTRY_NAME}:/var/lib/registry" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --restart=always \
    registry:2 >/dev/null
else
  echo "==> Registry '${REGISTRY_NAME}' already running"
fi

# 2. Kind cluster
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "==> Kind cluster '${CLUSTER_NAME}' already exists (skipping create)"
else
  echo "==> Creating Kind cluster '${CLUSTER_NAME}'"
  kind create cluster --name "${CLUSTER_NAME}" --config "${KIND_CONFIG}"
fi

# 3. Connect the registry to the cluster network (so control-plane nodes can
#    resolve "kind-registry" and pull images from it).
if docker network inspect kind 2>/dev/null | grep -q "\"${REGISTRY_NAME}\""; then
  echo "==> Registry already attached to the 'kind' network"
else
  echo "==> Attaching registry to the 'kind' network"
  docker network connect kind "${REGISTRY_NAME}" || true
fi

# 4. Document the registry address in the cluster so nodes pull from it.
#    Nodes reach the host registry via the special name "kind-registry".
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null 2>&1 || true

cat <<'EOF'

==> Kind cluster ready.

Next steps:
  1. Build + load images:   ./infra/scripts/kind-load-images.sh
  2. Deploy manifests:      kubectl apply -k infra/k8s/overlays/dev
  3. Port-forward:          kubectl port-forward svc/frontend 5175:8080

EOF