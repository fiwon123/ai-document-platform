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
# Run on the host (or CI) — NOT inside the dev container (no kind binary there).

set -euo pipefail

CLUSTER_NAME="ai-platform"
REGISTRY_NAME="kind-registry"
REGISTRY_IMAGE="registry:2.8.3"
REGISTRY_PORT="5000"

command -v kind >/dev/null 2>&1 || { echo "ERROR: 'kind' is required but not installed"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: 'docker' is required but not installed"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIND_CONFIG="${SCRIPT_DIR}/../kind/kind-config.yaml"

# 1. Local registry (idempotent: run, start, or create as needed).
if docker inspect "${REGISTRY_NAME}" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "${REGISTRY_NAME}")" != "true" ]; then
    echo "==> Starting existing (stopped) registry container '${REGISTRY_NAME}'"
    docker start "${REGISTRY_NAME}" >/dev/null
  else
    echo "==> Registry '${REGISTRY_NAME}' already running"
  fi
else
  if ! docker volume inspect "${REGISTRY_NAME}" >/dev/null 2>&1; then
    docker volume create "${REGISTRY_NAME}" >/dev/null
  fi
  echo "==> Creating local registry container '${REGISTRY_NAME}'"
  docker run -d \
    --name "${REGISTRY_NAME}" \
    -v "${REGISTRY_NAME}:/var/lib/registry" \
    -p "127.0.0.1:${REGISTRY_PORT}:5000" \
    --restart=always \
    "${REGISTRY_IMAGE}" >/dev/null
fi

# 2. Kind cluster.
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "==> Kind cluster '${CLUSTER_NAME}' already exists (skipping create)"
else
  echo "==> Creating Kind cluster '${CLUSTER_NAME}'"
  kind create cluster --name "${CLUSTER_NAME}" --config "${KIND_CONFIG}"
fi

# 3. Attach the registry to the 'kind' Docker network so cluster nodes can
#    resolve "kind-registry" and pull images from it.
KIND_NET_ID="$(docker network inspect kind -f '{{.Id}}' 2>/dev/null || true)"
if [ -n "${KIND_NET_ID}" ]; then
  if docker network inspect kind -f '{{range $k, $v := .Containers}}{{$k}} {{end}}' | grep -q "${REGISTRY_NAME}"; then
    echo "==> Registry already attached to the 'kind' network"
  else
    echo "==> Attaching registry to the 'kind' network"
    if ! docker network connect kind "${REGISTRY_NAME}"; then
      echo "WARNING: could not attach registry to 'kind' network — cluster nodes may not pull from it" >&2
    fi
  fi
else
  echo "WARNING: 'kind' Docker network not found — registry will not be reachable by name from nodes" >&2
fi

# 4. Point kubectl at the cluster.
if command -v kubectl >/dev/null 2>&1; then
  kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null
fi

cat <<'EOF'

==> Kind cluster ready.

Next steps:
  1. Build + push images:  ./infra/scripts/kind-load-images.sh
  2. Deploy manifests:     kubectl apply -k infra/k8s/overlays/dev
  3. Access the app:       http://localhost:18080  (frontend)
                           http://localhost:18001  (backend API)

EOF