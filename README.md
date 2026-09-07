# AI Document Intelligence Platform

Upload documents, search them semantically, and ask questions powered by AI.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Vite 8 |
| Backend | Python 3.14, FastAPI, SQLAlchemy |
| Database | PostgreSQL 16 + pgvector |
| Storage | MinIO (S3-compatible) |
| Cache | Redis 7 |
| AI | OpenAI API |
| Dev | Docker Compose, Dev Containers |

## Getting Started

### Dev Container (recommended)

1. Open this repo in VS Code with the Dev Containers extension
2. Services start automatically (PostgreSQL, Redis, MinIO, Backend, Frontend)
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

3. Start frontend:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/auth/register` | Register user |
| POST | `/v1/auth/login` | Login |
| GET | `/v1/auth/me` | Current user |
| POST | `/v1/documents/` | Upload document |
| GET | `/v1/documents/` | List documents |
| GET | `/v1/documents/{id}` | Get document |
| GET | `/v1/documents/{id}/download` | Get download URL |
| DELETE | `/v1/documents/{id}` | Delete document |
| POST | `/v1/search/` | Semantic search |
| POST | `/v1/qa/ask` | Ask question |
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

## Development

See [AGENTS.md](AGENTS.md) for development guidelines and workflow.