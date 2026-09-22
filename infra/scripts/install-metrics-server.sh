#!/usr/bin/env bash
# Install metrics-server into the local Kind cluster so the Horizontal
# Pod Autoscalers (infra/k8s/overlays/production/hpa.yaml) can scale.
#
# Usage: ./infra/scripts/install-metrics-server.sh
# Requires: Kind cluster up (see setup-kind.sh) + kubectl on the host.
#
# Kind's kubelet serves on a self-signed certificate and the control-plane
# advertises InternalIP, so metrics-server needs --kubelet-insecure-tls
# — that flag is ONLY appropriate for local testing, never production.

set -euo pipefail

METRICS_SERVER_VERSION="${METRICS_SERVER_VERSION:-v0.7.2}"
MANIFEST="https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_SERVER_VERSION}/components.yaml"

command -v kubectl >/dev/null 2>&1 || { echo "ERROR: 'kubectl' is required but not installed"; exit 1; }

if ! kubectl config current-context >/dev/null 2>&1; then
  echo "ERROR: no active kubectl context — is the Kind cluster up?"; exit 1
fi

echo "==> Applying metrics-server ${METRICS_SERVER_VERSION}"
kubectl apply -f "${MANIFEST}"

echo "==> Allowing insecure kubelet TLS (Kind only)"
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

echo "==> Waiting for metrics-server rollout"
kubectl -n kube-system rollout status deployment/metrics-server --timeout=120s

echo "==> Verifying: kubectl top nodes"
kubectl top nodes

echo "==> Done. HPAs can now autoscale."
echo "    NOTE: production clusters (EKS/K3s/...) ship or install metrics-server via their provider; --kubelet-insecure-tls is Kind-only."