# AI Document Intelligence Platform — Backend

FastAPI backend for the AI Document Intelligence Platform: document upload and
storage, asynchronous background processing (text extraction → chunking →
embeddings), semantic search over pgvector, LLM question answering, webhooks,
and role-based user management.

## Stack

- **Python 3.14** managed with [uv](https://docs.astral.sh/uv/)
- **FastAPI** application with layered architecture:
  `routes` → `services` → `repositories` → `models`
- **PostgreSQL** (pgvector) for structured data + vector embeddings
- **Redis** for queue (arq), caching, and rate limiting
- **MinIO/S3** for document object storage
- **JWT** auth (access token + rotating refresh cookie)
- **Prometheus** `/metrics` endpoint for monitoring

## Quick start (host-native)

```bash
cd backend
uv sync                          # install deps
cp .env.example .env             # create env file (adjust values)
uv run alembic upgrade head      # apply migrations
uv run uvicorn app.main:app --reload --port 8000
```

The API is served at `http://localhost:8000` with interactive docs at
`/docs`. For the full dev sandbox (uvicorn + vite + worker + infra in Docker),
see the repo root `DEVELOPMENT.md`.

## Configuration

Backend configuration lives in `backend/.env` (gitignored). Copy
`.env.example` and adjust. Key groups:

| Area | Variables |
|------|-----------|
| Database | `POSTGRES_*`, `DATABASE_URL` |
| Redis | `REDIS_*`, `REDIS_MAX_CONNECTIONS` |
| Storage | `MINIO_*` |
| Auth | `SECRET_KEY`, `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS`, `REFRESH_COOKIE_SECURE` |
| AI | `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `LOCAL_LLM_*`, `LOCAL_EMBEDDING_*` |
| Rate limit | `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW`, `TRUST_PROXY_HEADERS` |
| CORS | `CORS_ORIGINS` |

## API surface (all under `/v1`)

- **Auth** — `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/me`
- **Users** — `PUT /users/me`, `DELETE /users/me`; admin: `GET /users/`,
  `PATCH /users/{id}/role`, `PATCH /users/{id}/active`, `DELETE /users/{id}`
- **Documents** — `POST /documents/`, `POST /documents/bulk`,
  `GET /documents/`, `GET /documents/{id}`, `GET /documents/{id}/status`,
  `GET /documents/{id}/preview`, `GET /documents/{id}/download`,
  `GET /documents/{id}/thumbnail`, `DELETE /documents/{id}`
- **Search** — `POST /search/`, `POST /search/export`
- **QA** — `POST /qa/ask`, `GET /qa/models`
- **Webhooks** — `GET|POST /webhooks/`, `PUT|DELETE /webhooks/{id}`,
  `POST /webhooks/{id}/test`
- **Statistics** — `GET /statistics/me`, `GET /statistics/admin` (admin)
- **Health** — `GET /health`

## Architecture

```
React (frontend)
  ↓ /v1
FastAPI routes        → request handling, validation
  ↓
Services              → business logic, orchestration
  ↓
Repositories          → SQLAlchemy queries
  ↓
PostgreSQL (pgvector) / Redis (queue+cache) / MinIO (objects)
  ↓
arq worker            → text extraction → chunking → embeddings → thumbnails
  ↓
OpenAI / Groq APIs
```

## Background processing

The arq worker (`app.worker.WorkerSettings`) processes documents asynchronously:

1. Transition document to `processing`
2. Download the file from MinIO
3. Extract text (PDF / text / JSON)
4. Split into overlapping chunks
5. Generate embeddings (best-effort — graceful fallback to text search)
6. Render a first-page PDF thumbnail (best-effort)
7. Mark `ready`, invalidate caches, dispatch webhooks

A cron job (`recover_stale_documents`) reclaims documents stuck in
`pending`/`processing` for more than 30 minutes.

## Testing

```bash
uv run pytest                      # full suite (needs postgres/redis/minio up)
uv run pytest tests/test_document.py
uv run ruff check src/             # lint
```

Tests live in `backend/tests/`, use pytest fixtures from `conftest.py`, and
mock external services (OpenAI, MinIO, Redis).

## Migrations

```bash
uv run alembic upgrade head                          # apply
uv run alembic revision --autogenerate -m "..."      # new migration
uv run alembic history                               # history
```

## Layout

```
backend/
├── src/app/
│   ├── main.py            # FastAPI app entry point
│   ├── routes/            # API route handlers
│   ├── services/          # business logic
│   ├── repositories/      # database queries
│   ├── models/            # SQLAlchemy ORM models
│   ├── schemas/           # Pydantic request/response models
│   ├── storage/           # MinIO/S3 client
│   ├── cache/             # Redis client
│   ├── middleware/        # rate limiting + logging/metrics
│   └── worker/            # arq background processor
├── migrations/            # Alembic migrations
├── tests/                 # pytest suite
├── .env.example           # environment template
└── pyproject.toml         # deps (uv)
```

See the repo root `README.md` / `PROJECT_CONTEXT.md` for the full platform
overview and `AGENTS.md` for development workflow.