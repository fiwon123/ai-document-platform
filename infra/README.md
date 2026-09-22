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