# Infrastructure

Production deployment assets for the AI Document Intelligence Platform:
Kubernetes manifests (Kustomize), a Helm chart, Docker builds, and the local
Kind / DevSpace development flow.

## Layout

| Path | Purpose |
|------|---------|
| `docker/` | Multi-stage production Dockerfiles (`Dockerfile.backend`, `Dockerfile.worker`, `Dockerfile.frontend`) |
| `k8s/base/` | Kustomize base: namespace, deployments, services, config, placeholder Secret, migrate Job |
| `k8s/overlays/dev/` | Kind dev overlay (localhost:5000 registry, NodePorts, single replicas) |
| `k8s/overlays/production/` | Production overlay (replicas, HPA, PDB, NetworkPolicies, cert-manager, External Secrets) |
| `helm/ai-platform/` | Standalone Helm chart (same components, flag-driven) |
| `kind/` | Kind cluster config (local registry containerd mirror, NodePorts) |
| `scripts/` | `setup-kind.sh`, `kind-load-images.sh`, `build-images.sh`, `teardown-kind.sh` |

## Local development (Kind + DevSpace)

See the root README "Kubernetes (Kind + DevSpace)" section:

```bash
./infra/scripts/setup-kind.sh   # create kind-registry + cluster
devspace dev                    # build, deploy, hot-reload
```

## Deploying

Kustomize (production):

```bash
kustomize build infra/k8s/overlays/production | kubectl apply -f -
```

Helm:

```bash
helm install ai-platform infra/helm/ai-platform \
  --namespace ai-platform --create-namespace \
  --set image.repository=ghcr.io/<owner>/ai-platform ...
```

Images are built and pushed to `ghcr.io/fiwon123/ai-platform/*` by the Infra
CI workflow on every merge to `dev` (SHA + `latest` tags).

## Secrets management (External Secrets Operator)

The base ships a **dev-placeholder** `app-secrets` Secret. In production the
production overlay and the Helm chart (with `secrets.eso.enabled=true`) switch
to **External Secrets Operator**: a ClusterSecretStore points at the cloud
secret manager and an ExternalSecret materializes the same `app-secrets`
Secret with the keys the Deployments consume (`envFrom`) — no application
changes.

Prerequisites:

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace
# AWS credentials for the ClusterSecretStore (omitted when using IRSA):
kubectl -n ai-platform create secret generic eso-aws-creds \
  --from-literal=access-key-id=AKIA... \
  --from-literal=secret-access-key=...
```

Remote secret layout (AWS Secrets Manager, id `ai-platform/production/backend`):

```text
SECRET_KEY, POSTGRES_PASSWORD, MINIO_ACCESS_KEY, MINIO_SECRET_KEY,
DATABASE_URL, OPENAI_API_KEY, GROQ_API_KEY
```

### Rotation

1. Update the value in the secret manager (e.g. new `SECRET_KEY`).
2. ESO pulls the change on the `refreshInterval` (default `1h`) and updates
   the `app-secrets` Secret in place — no redeploys, no `kubectl apply`.
3. To rotate immediately: `kubectl -n ai-platform annotate externalsecret
   app-secrets force-sync=$(date +%s)` — ESO re-syncs, then restart the
   backend/worker pods to pick up the new env (`kubectl -n ai-platform
   rollout restart deploy/backend deploy/worker` — the migrate Job re-runs on
   deploy; a changed `DATABASE_URL`/`POSTGRES_PASSWORD` affects the DB
   credentials on first sync).

## Monitoring (Prometheus + Grafana + metrics-server)

The backend exposes a Prometheus `/metrics` endpoint (default registry: process
metrics + `http_requests_total{method,path,status}` counter +
`http_request_duration_seconds{method,path}` histogram; variable path
segments — UUIDs, numeric ids — are normalized to `{id}` so cardinality stays
bounded; the `/metrics` endpoint itself is not instrumented). See
`backend/src/app/main.py` and `backend/src/app/middleware/logging.py`.

The production overlay (`monitoring.yaml`) and the Helm chart (with
`monitoring.enabled=true`) ship kube-prometheus-stack integration:

| Resource | Purpose |
|----------|---------|
| ServiceMonitor `backend` | scrapes `<backend-service>:/metrics` (port `http`, 30s) |
| PrometheusRule `ai-platform` | `BackendDown`, `BackendHighErrorRate`, `BackendLatencyHigh` |
| AlertmanagerConfig `ai-platform` | routes warning/critical alerts to email (SMTP placeholders) |
| Grafana dashboard ConfigMap | request rate, p95 latency, 5xx rate, RSS memory (`grafana_dashboard: "1"` sidecar label) |

Prerequisites (once per cluster):

```bash
# metrics-server (needed by the HPAs; Kind needs --kubelet-insecure-tls,
# which install-metrics-server.sh patches in — Kind-only, never production)
./infra/scripts/install-metrics-server.sh

# kube-prometheus-stack (Prometheus + Alertmanager + Grafana)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace
```

Then deploy the production overlay (ServiceMonitors/PrometheusRules/
AlertmanagerConfigs are picked up regardless of namespace; the backend
Service is selected via `app.kubernetes.io/component: backend`, and targets
are restricted to the `ai-platform` namespace via `namespaceSelector`).

Grafana access:

```bash
kubectl -n monitoring port-forward svc/prometheus-stack-grafana 3000:80
```

Alerts are routed to `ops@example.com` via `smtp.example.com:587` — before
enabling the route, replace the placeholder recipients/relay in
`monitoring.yaml` (or chart values `monitoring.*`) and create the SMTP
credentials:

```bash
kubectl -n monitoring create secret generic smtp-auth \
  --from-literal=password='...'
```

## Logging (Loki + Promtail)

The production overlay (`logging.yaml`) and the Helm chart (with
`logging.enabled=true`) ship centralized logging in the `monitoring`
namespace:

| Resource | Purpose |
|----------|---------|
| Loki StatefulSet + PVC (10Gi) | single-binary, filesystem storage, retention 7d (`limits_config.retention_period`) |
| Promtail DaemonSet | tails `/var/log/pods` on every node (Kubernetes pod discovery), pushes to `http://loki:3100/loki/api/v1/push` |
| Loki datasource ConfigMap | auto-loaded by Grafana (`grafana_datasource: "1"`) |

Promtail needs cluster-wide read access to pods — it ships a
ServiceAccount + ClusterRole(`pods get/list/watch`)/ClusterRoleBinding.

Log labels: `namespace`, `pod`, `container`, `component`
(`app.kubernetes.io/component`), `image`, `uid`.

Query in Grafana → Explore → datasource **Loki**, e.g.:

```text
{namespace="ai-platform"} |= "error"
{namespace="monitoring", component="loki"}
```

Retention: change `limits_config.retention_period` (overlay) or
`logging.retentionPeriod` (chart) — e.g. `720h` = 30 days. Storage: the
PVC is `logging.storageSize` (chart) / 10Gi (overlay); Loki runs as a
single replica — scale out by switching the storage backend for larger
deployments.

Kind: Loki/Promtail run fine on the local cluster; the Promtail DaemonSet
reads the kubelet's `/var/log` hostPath.

## Environments

| Overlay | Images | Replicas | Ingress/TLS | Use |
|---------|--------|----------|-------------|-----|
| `infra/k8s/overlays/dev` | `localhost:5000/*:latest` (Kind registry) | 1/1/1 | NodePorts | local Kind, DevSpace hot reload |
| `infra/k8s/overlays/staging` | `ghcr.io/fiwon123/ai-platform/*:latest` | 2/1/1 | yes — Let's Encrypt **staging** issuer | pre-production validation |
| `infra/k8s/overlays/production` | `ghcr.io/fiwon123/ai-platform/*:latest` | 3/2/2 + HPAs | yes — Let's Encrypt **prod** issuer | live |

Staging mirrors production (cert-manager + ingress + real registry) with
moderate replicas and smaller resource limits, so a production-like deploy
can be validated before going live. Hostnames/issuers are placeholders
(`staging.example.com`, `ops@example.com`) — replace before use.

### Staging needs its own JWT signing key

Unlike production, the staging overlay does **not** replace the base
`app-secrets` Secret: it includes only the base, the cert-manager resources
and the ingress, so `SECRET_KEY` is still the value committed in
`infra/k8s/base/secret.yaml` (`your-secret-key-change-in-production`).

Since #524 the backend refuses to start on any signing key this repository
publishes, so **staging will CrashLoop until a real secret is injected** —
that is the intended fail-closed behaviour, not a regression. Anyone who
could read this repository could otherwise mint a valid access token for any
staging user id.

To bring it up, add a real secret to the staging overlay (an `ExternalSecret`
mirroring the production one, or a `secretGenerator`/patch setting `SECRET_KEY`
to a generated value). Do **not** reach for `ALLOW_PLACEHOLDER_SECRET_KEY`:
only `infra/k8s/overlays/dev` sets it, and
`backend/tests/test_published_key_deployment.py` fails if staging or production
ever does. The Helm chart is covered by the same guard — a chart install left at
`secrets.jwtSecretKey: "change-me-jwt-secret"` also refuses to boot.

## End-to-end smoke test (Kind)

`infra/scripts/smoke-test.sh` runs the full stack on a Kind cluster (host or
CI — Docker/kind required) and asserts:

1. backend · `GET /v1/health` → 200
2. frontend · `GET /` → 200 (SPA serves)
3. API round-trip · register → login → upload → status → search → 200

It reuses `setup-kind.sh` (cluster + local registry) and
`kind-load-images.sh` (build + load images) as the bootstrap, applies the
dev overlay, waits for rollouts, and checks the services through the Kind
host ports (`127.0.0.1:18001` backend, `127.0.0.1:18080` frontend).

```bash
./infra/scripts/smoke-test.sh
```

The Infra CI workflow runs this job (`smoke`) on every dev push. Note: with
neither `OPENAI_API_KEY` nor a local embedding provider (`LOCAL_LLM_ENABLED` plus
a pulled embedding model), document processing ends in `failed` (no embeddings)
— the smoke test asserts the API surface (upload/status/search respond
correctly), not processing success.

## GitOps (ArgoCD)

`infra/argo/` holds the GitOps manifests (app-of-apps):

| File | Resource | Manages |
|------|----------|---------|
| `apps.yaml` | ApplicationSet `ai-platform` | one Application per env — `ai-platform-dev` → `infra/k8s/overlays/dev` (branch `dev`), `ai-platform-staging` → `infra/k8s/overlays/staging` (branch `main`), `ai-platform-production` → `infra/k8s/overlays/production` (branch `main`) |
| `app-of-apps.yaml` | Application `ai-platform-apps` | the `infra/argo` directory itself (self-managing) |

Install ArgoCD (once per cluster):

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
# or: helm install argo-cd argo/argo-cd -n argocd

# Bootstrap the GitOps config (root app + ApplicationSet):
kubectl apply -f infra/argo/
```

Both Applications use the default `automated` sync with `prune: true` +
`selfHeal: true` and `CreateNamespace=true`, so the stack deploys itself from
git with no manual `kubectl apply` of the overlays.

**CD flow with CI**: the Infra CI workflow builds and pushes
`ghcr.io/fiwon123/ai-platform/{backend,worker,frontend}` (SHA + `latest`) on
every dev merge. The production overlay's images are `latest`-pinned, so a
merged manifest change triggers an automatic ArgoCD sync. For **controlled
rollouts**, pin a SHA tag in the overlay (`kustomize edit set image
ai-platform/backend=ghcr.io/fiwon123/ai-platform/backend:<sha>`); **rollback**
is then a git revert of the pinned commit (or `argocd app rollback
ai-platform-production`).

Kind/DevSpace is unaffected — the dev Application points at the dev overlay
(images `localhost:5000/*:latest`, DevSpace hot reload).

## TLS (cert-manager)

`cert-manager.yaml` (production overlay) / `certManager.enabled` (chart):
Let's Encrypt staging + production ClusterIssuers (HTTP-01 via the nginx
ingress class) and a `selfsigned` issuer for plain local testing. The Ingress
is annotated `cert-manager.io/cluster-issuer: letsencrypt-prod`; replace
`ops@example.com` before going live.

## Validation

The Infra CI workflow (`.github/workflows/infra.yml`) validates every change:
`kustomize build` on both overlays, `helm lint` + `helm template`, and
`kubeconform` schema checks (CRDs are Skipped via `-ignore-missing-schemas`).
Run the same locally:

```bash
kustomize build infra/k8s/overlays/production > /tmp/prod.yaml
helm lint infra/helm/ai-platform
helm template ai-platform infra/helm/ai-platform > /tmp/helm.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/prod.yaml
kubeconform -strict -ignore-missing-schemas -summary /tmp/helm.yaml
```