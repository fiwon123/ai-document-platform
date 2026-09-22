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
| Dev | Docker Compose, Dev Containers |

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

### Dev Container (recommended)

1. Open this repo in VS Code with the Dev Containers extension
2. Services start automatically (PostgreSQL, Redis, MinIO, Backend, Frontend, Worker)
3. Open http://localhost:5173

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

Full API docs: `http://localhost:8000/docs`

## Project Structure

```
backend/          Python/FastAPI backend
frontend/         React/TypeScript frontend
.devcontainer/    Dev Container config
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

See [AGENTS.md](AGENTS.md) for development guidelines and workflow.