# AGENTS.md

### Product

## Project Objective

AI Document Intelligence Platform.

### Problem

Companies store large amounts of information in PDFs, documents, and internal knowledge bases. Users need a fast and reliable way to find relevant information and ask questions about their documents.

### Goal

Build a platform where users can:

- Upload documents
- Process documents asynchronously
- Extract and split document text
- Generate embeddings
- Search documents semantically
- Ask questions about their documents
- Receive contextual answers from an LLM

### Main technology

- Frontend: React 19, TypeScript, Vite
- Backend: Python, FastAPI
- Database: PostgreSQL
- ORM: SQLAlchemy
- Storage: MinIO/S3
- Queue and cache: Redis
- Background jobs: Redis-based worker system
- Authentication: JWT
- Vector search: pgvector, when needed
- AI: OpenAI or another compatible LLM API
- Development: Docker and Dev Containers

### Core architecture

```text
React
  ↓
FastAPI
  ↓
PostgreSQL
  ↓
Redis Queue
  ↓
Background Document Processor
  ↓
Embeddings and LLM API

## Project Structure

Full-stack monorepo: Python/FastAPI backend + React/TypeScript frontend.

```

backend/ # FastAPI app, PostgreSQL, MinIO/S3 storage
frontend/ # React 19, Vite 8, TypeScript
.devcontainer/ # Docker Compose dev environment

````

## Development Commands

### Backend (Python 3.14)

```bash
cd backend
uv sync              # Install dependencies
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
uv run alembic upgrade head  # Run database migrations
uv run alembic revision --autogenerate -m "description"  # Create new migration
```

### Frontend (Node 22)

```bash
cd frontend
npm install          # Install dependencies
npm run dev          # Start dev server (port 5173)
npm run build        # TypeScript check + Vite build
npm run lint         # Run oxlint
npm run lint:fix     # Auto-fix lint issues
```

### Docker Compose (Full Stack)

```bash
# Start all services (PostgreSQL, Redis, MinIO, Backend, Frontend)
docker compose up -d

# Start only infrastructure services
docker compose up -d postgres redis minio

# View logs
docker compose logs -f backend
docker compose logs -f postgres

# Stop all services
docker compose down

# Stop and remove volumes (clean slate)
docker compose down -v
```

## Architecture

### Backend Layering

- **Routes** (`backend/src/app/routes/`): FastAPI routers, request handling
- **Services** (`backend/src/app/services/`): Business logic, orchestration
- **Repositories** (`backend/src/app/repositories/`): SQLAlchemy database queries
- **Models** (`backend/src/app/models/`): SQLAlchemy ORM models
- **Schemas** (`backend/src/app/schemas/`): Pydantic request/response models
- **Storage** (`backend/src/app/storage/`): MinIO/S3 client (boto3)
- **Cache** (`backend/src/app/cache/`): Redis client for caching

### API Routing

- Frontend proxies `/v1/*` to backend (`vite.config.ts:8`)
- Backend mounts all routes under `/v1` (`backend/src/app/main.py:17`)
- Document CRUD: `POST /v1/documents/`, `GET /v1/documents/{id}`, `DELETE /v1/documents/{id}`
- Health check: `GET /v1/health` (checks PostgreSQL, Redis, MinIO)

### Infrastructure Services

- **PostgreSQL** (port 5432): Primary database
- **Redis** (port 6379): Caching layer
- **MinIO** (ports 9000/9001): S3-compatible object storage
  - Console: http://localhost:9001 (minioadmin/minioadmin)

### Dev Container

- Services run in Docker Compose: `backend` (Python 3.14) + `frontend` (Node 20)
- Forwarded ports: 8000 (API), 5173 (Vite dev server)
- Post-create: installs `opencode-ai` globally, syncs backend deps, installs frontend deps

## Environment Variables

Backend reads from `backend/src/app/.env` (gitignored):
- `POSTGRES_*`: Database connection (defaults: `localhost:5432/mydb`)
- `REDIS_*`: Redis connection (defaults: `localhost:6379`)
- `MINIO_*`: S3-compatible storage (defaults: `localhost:9000`, bucket: `documents`)
- `DATABASE_URL`: Full PostgreSQL URL (used by Alembic)
- `SECRET_KEY`: JWT signing key (required)
- `ALGORITHM`: JWT algorithm (default: HS256)

## Database Migrations

Alembic manages database schema changes:
```bash
cd backend
uv run alembic upgrade head  # Apply all migrations
uv run alembic revision --autogenerate -m "add feature"  # Create migration
uv run alembic history  # View migration history
uv run alembic current  # View current revision
```

## Key Conventions

- Python package manager: **uv** (not pip/poetry)
- Linting: **oxlint** (frontend), no backend linter configured
- No test suite present
- No CI/CD workflows configured
- Auth is stubbed: `get_current_user_id()` returns hardcoded UUID
- Database uses UUID primary keys for all models
- MinIO objects stored at: `users/{owner_id}/documents/{document_id}/{filename}`

## Environment and secret-file rules

- The backend environment file is `backend/src/app/.env`.
- Never access it without explicit permission.
- Never open, read, print, summarize, quote, or send the contents of `.env`, `.env.*`, or any other environment/secret file unless the user explicitly gives permission in the current conversation.
- Never access secret files automatically during project analysis.
- Never run commands such as:
  - `cat .env`
  - `less .env`
  - `printenv`
  - `env`
  - `export`
  - `grep` or `sed` commands that may reveal environment values
- Never display, repeat, log, store, or include secret values in the response, code changes, patches, terminal output, or commits.

If the user explicitly permits reading environment configuration:

1. Read only non-secret variables.
2. Do not read or reveal variables whose names contain:
   - `KEY`
   - `TOKEN`
   - `SECRET`
   - `PASSWORD`
   - `PASS`
   - `CREDENTIAL`
   - `AUTH`
   - `PRIVATE`
   - `CERT`
   - `COOKIE`
   - `WEBHOOK`
   - `DATABASE_URL`
   - `CONNECTION_STRING`
3. Do not reveal the values of ambiguous variables. Ask for permission before reading them.
4. You may read safe configuration variables such as:
   - `NODE_ENV`
   - `ENVIRONMENT`
   - `PORT`
   - `HOST`
   - `API_URL`
   - `BACKEND_URL`
   - `FRONTEND_URL`
   - `DEBUG`
5. If a file contains both safe and secret variables, read only the explicitly approved safe variables.
6. Never include secret values in the final answer. Refer to them only by variable name, for example, `STRIPE_SECRET_KEY is configured`.
7. Prefer checking whether a variable exists rather than printing its value.
