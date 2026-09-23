# AI Document Intelligence Platform

Upload documents, search them semantically, and ask questions powered by AI.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite 8 |
| Backend | Python 3.14, FastAPI, SQLAlchemy |
| Database | PostgreSQL 16 + pgvector |
| Storage | MinIO (S3-compatible) |
| Cache & Queue | Redis 7 (arq worker) |
| AI | OpenAI API (embeddings + chat) |
| Background jobs | arq-based Redis worker service |
| CI | GitHub Actions (lint, build, pytest) |
| Dev | Docker Compose dev sandbox (uvicorn + vite + arq worker), mise, Makefile |

## Features

- Upload documents, processed asynchronously by a background worker
- Text extraction, chunking, and embedding generation during processing
- Vector-based semantic search over document chunks (with text fallback)
- Question answering over the indexed documents
- Per-document search/QA scoping (filter by selected documents)
- Dashboard statistics (document counts by status, chunk totals)
- JWT authentication with admin role management
- Redis caching for search results and document metadata

## Getting Started

### Dev Sandbox (recommended)

1. `make dev-up` — builds the dev image (mise + deps baked) and starts
   uvicorn (`--reload`) + Vite (HMR) + arq worker + postgres + redis + minio
2. Open http://localhost:5175 (frontend) / http://localhost:8001/docs (API)
3. `make dev-log` to tail sandbox logs; `make dev-down` to stop (volumes kept);
   `make dev-build` to rebuild the image after `pyproject.toml`/`uv.lock` changes
4. Code with AI inside the sandbox: `make opencode` (agent TUI, runs with
   `--auto` — permission prompts auto-approved) or `make sandbox` (plain
   shell) — same files, stack at :8000/:5173

See `DEVELOPMENT.md` for the daily loop and golden rules.

### Manual Setup

1. Start infrastructure:

   ```bash
   docker compose up -d postgres redis minio
   ```

2. Start backend:

   ```bash
   cd backend
   uv sync
   uv run alembic upgrade head
   uv run uvicorn app.main:app --port 8000 --reload
   ```

3. Start the background worker:

   ```bash
   cd backend
   uv run arq app.worker.WorkerSettings
   ```

4. Start frontend:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

### Kubernetes (Kind + DevSpace)

Local development *inside* a Kind cluster with hot reload (run on the host —
Docker and Kind are required, see `infra/scripts/setup-kind.sh`):

```bash
# 1. Create the Kind cluster + local registry (localhost:5000)
./infra/scripts/setup-kind.sh

# 2. Build, deploy and start the dev containers (backend uvicorn --reload,
#    frontend Vite dev server) with live source sync
devspace dev

# 3. Stop dev containers / tear down
devspace dev --stop
devspace purge
```

- Backend sources sync into the running pod (`backend/src/app` → `/app/src/app`);
  uvicorn reloads on save — API on `http://localhost:8000`.
- Frontend runs the Vite dev server inside the cluster — `http://localhost:5173`.
- The stack deploys to the `ai-platform` namespace from the dev Kustomize
  overlay (`infra/k8s/overlays/dev`).

### Production TLS (cert-manager)

The production overlay and Helm chart ship with cert-manager ClusterIssuers
(Let's Encrypt staging + production, plus a self-signed one for local
testing). Install cert-manager, then deploy:

```bash
# 1. Install cert-manager (once per cluster)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml

# 2. Deploy the production overlay — the Ingress is annotated
#    cert-manager.io/cluster-issuer: letsencrypt-prod and cert-manager
#    creates/renews the TLS secret automatically.
kustomize build infra/k8s/overlays/production | kubectl apply -f -
```

- Replace `ops@example.com` in `cert-manager.yaml` / chart values with the
  real ops email before going live.
- Local Kind testing: point the ingress annotation (or chart value
  `certManager.clusterIssuer`) at `selfsigned` for functional TLS.

### Production secrets (External Secrets Operator)

The production overlay and Helm chart (with `secrets.eso.enabled=true`)
materialize the `app-secrets` Secret from a cloud secret manager via
[External Secrets Operator](https://external-secrets.io) — the plaintext dev
placeholder is never deployed. See `infra/README.md` for the provider setup,
secret layout, and rotation workflow.

### Production monitoring (Prometheus + Grafana)

The production overlay and Helm chart (with `monitoring.enabled=true`) ship
kube-prometheus-stack integration: a ServiceMonitor scraping the backend
`/metrics` endpoint (process + HTTP metrics), alert rules (down / high 5xx /
high latency), an AlertmanagerConfig email route, and an auto-loaded Grafana
dashboard.

```bash
# 1. Install metrics-server (Kind only — enables HPA autoscaling locally)
./infra/scripts/install-metrics-server.sh

# 2. Install kube-prometheus-stack (once per cluster)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace

# 3. Deploy the production overlay (or render the Helm chart with
#    monitoring.enabled=true) — metrics and alerts go live automatically.
kustomize build infra/k8s/overlays/production | kubectl apply -f -
```

- Grafana: `kubectl -n monitoring port-forward svc/prometheus-stack-grafana 3000:80`
  (default admin/admin).
- Alerts route to `ops@example.com` via SMTP — replace with real values and
  create the `smtp-auth` Secret in `monitoring` before enabling the route.
See `infra/README.md`.

### Staging environment

`infra/k8s/overlays/staging` is a production-like pre-production environment:
real registry images (ghcr.io), ingress + TLS via the Let's Encrypt **staging**
ClusterIssuer, moderate replicas (2/1/1) and smaller resource limits.
Deployed by ArgoCD (`ai-platform-staging`) like production — see
`infra/README.md`.

### End-to-end smoke test (Kind)

`infra/scripts/smoke-test.sh` boots the whole stack on a local Kind cluster
(reusing `setup-kind.sh` + `kind-load-images.sh`), applies the dev overlay and
asserts backend health (200), frontend reachability (200) and an API
round-trip (register → login → upload → status → search). Runs on every dev
push in the Infra CI (`smoke` job).

```bash
./infra/scripts/smoke-test.sh
```

### Production logging (Loki + Promtail)

The production overlay and Helm chart (with `logging.enabled=true`) ship
centralized logging: a Loki StatefulSet (filesystem storage, 7-day retention)
and a Promtail DaemonSet tailing pod logs on every node. Grafana picks up the
Loki datasource automatically:

```bash
kustomize build infra/k8s/overlays/production | kubectl apply -f -
# then in Grafana → Explore → Loki:
#   {namespace="ai-platform"} |= "error"
```

Tune retention (`logging.retentionPeriod` / `limits_config.retention_period`)
and storage size (`logging.storageSize`) via chart values. See
`infra/README.md`.

### GitOps deployment (ArgoCD)

`infra/argo/` ships an app-of-apps GitOps setup: ArgoCD self-manages the
Kustomize overlays from this repo — `ai-platform-dev` (branch `dev`) and
`ai-platform-production` (branch `main`) — with automated sync, self-heal and
prune. Rollouts follow the CI image pushes; rollback is a git revert.

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl apply -f infra/argo/   # bootstrap root app + ApplicationSet
```

See `infra/README.md`.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/auth/register` | Register user |
| POST | `/v1/auth/login` | Login |
| GET | `/v1/auth/me` | Current user |
| POST | `/v1/documents/` | Upload document |
| GET | `/v1/documents/` | List documents |
| GET | `/v1/documents/{id}` | Get document |
| GET | `/v1/documents/{id}/status` | Poll processing status |
| GET | `/v1/documents/{id}/download` | Get download URL |
| DELETE | `/v1/documents/{id}` | Delete document |
| POST | `/v1/search/` | Semantic search (`document_ids` optional) |
| POST | `/v1/qa/ask` | Ask question (`document_ids` optional) |
| GET | `/v1/statistics/me` | Workspace statistics |
| PUT | `/v1/users/me` | Update own profile |
| DELETE | `/v1/users/me` | Delete own account |
| GET | `/v1/users/` | List users (admin) |
| PATCH | `/v1/users/{id}/role` | Change user role (admin) |
| DELETE | `/v1/users/{id}` | Delete user (admin) |
| GET | `/v1/health` | Health check |

Full API docs: `http://localhost:8001/docs`

## Project Structure

```
backend/          Python/FastAPI backend
frontend/         React/TypeScript frontend
Dockerfile        Dev sandbox image (mise runtime + deps baked)
docker-compose.yaml  Dev sandbox: dev (uvicorn+vite), worker, postgres, redis, minio
dev-entrypoint.sh Dev sandbox entrypoint (alembic + uvicorn + vite, hot reload)
Makefile          Dev workflow targets (dev-up, infra-up, check, ...)
mise.toml         Tool versions (node/uv/gh)
.github/          CI workflows, dependabot, templates
.opencode/        AI agent config and instructions
```

## Testing

Backend (requires PostgreSQL, Redis, MinIO running locally):

```bash
cd backend
uv run pytest
uv run ruff check src/
```

Frontend:

```bash
cd frontend
npm test
npm run lint
npm run build
```

## Development

See [AGENTS.md](AGENTS.md) for development guidelines and workflow, and
[DEVELOPMENT.md](DEVELOPMENT.md) for the daily-loop cheatsheet (golden rules:
`make dev-up` → `make dev-log` → `make dev-down`; `make check` before every
push; only `dev-up` requires opencode).