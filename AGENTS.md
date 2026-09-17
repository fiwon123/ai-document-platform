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

### Core Architecture

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
```

## Project Structure

Full-stack monorepo: Python/FastAPI backend + React/TypeScript frontend.

```text
backend/       # FastAPI app, PostgreSQL, MinIO/S3 storage
frontend/      # React 19, Vite 8, TypeScript
.devcontainer/ # Docker Compose dev environment
```

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

## Runtime Environment

The AI agent (opencode) runs **inside a Dev Container**, not on a bare machine.

### No docker CLI inside the container

- `docker` and `docker compose` commands are **NOT available** inside the Dev Container
- Infrastructure services (PostgreSQL, Redis, MinIO) run in separate containers on the host
- They are reachable via forwarded ports on `localhost`

### What the agent CAN do

- Run backend commands: `uv`, `python`
- Run frontend commands: `npm`, `npx`, `node`
- Run git commands: `git`, `gh`
- Access services at forwarded ports (see below)

### Service ports (forwarded from host)

Host ports of the Docker Compose stack (container-internal ports stay at the
standard values: 5432, 6379, 8000, 5173):

- PostgreSQL: `localhost:5434`
- Redis: `localhost:63790`
- MinIO API: `localhost:9000` / Console: `localhost:9001`
- Backend API: `localhost:8001`
- Frontend Dev: `localhost:5175`

### What the agent CANNOT do

- Run `docker` or `docker compose` commands
- Access the Docker socket
- Modify the host filesystem (only `/workspace` is writable)

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

- **PostgreSQL** (host port 5434 → container 5432): Primary database
- **Redis** (host port 63790 → container 6379): Caching layer
- **MinIO** (ports 9000/9001): S3-compatible object storage
  - Console: http://localhost:9001 (minioadmin/minioadmin)

### Dev Container

- Services run in Docker Compose: `backend` (Python 3.14) + `frontend` (Node 22)
- Forwarded ports: 8001 (API), 5175 (Vite dev server)
- Post-create: installs `opencode-ai` globally, syncs backend deps, installs frontend deps

## Environment Variables

Backend reads from `backend/src/app/.env` (gitignored):
- `POSTGRES_*`: Database connection (defaults: `localhost:5434/mydb`)
- `REDIS_*`: Redis connection (defaults: `localhost:63790`)
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
- Test suite not yet written — see `.opencode/instructions/testing.md` for the plan
- GitHub Actions CI runs lint + build on PRs (`.github/workflows/ci.yml`)
- Dependabot groups dependency updates (`.github/dependabot.yml`)
- Auth is fully implemented with JWT (register, login, me) — `backend/src/app/routes/auth.py`
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

## Development Workflow

### Git Workflow

- Branch from `dev` (not `main`)
- Never push directly to `dev` or `main`
- Branch naming: `<type>/<issue-number>-<slug>` (e.g., `feat/42-document-chunking`)
- Branch types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`, `ci/`
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`
- All testing is local for feature branches — CI only runs on `dev` → `main` PRs
- Do NOT merge pull requests unless explicitly instructed
- Do NOT automatically create release PRs or merge to main — user must explicitly request
- Always return to `dev` branch after completing any merge
- Every change is tracked on GitHub: **issue → branch → PR → merge**

### Branch Strategy

```text
main          ← release merges (CI runs here)
  └── dev     ← integration branch (all feature branches merge here)
        ├── feat/<issue>-<slug>
        ├── fix/<issue>-<slug>
        └── refactor/<issue>-<slug>
```

- Feature branches: `feat/<issue>-<slug>` → merge to `dev`
- Release: `dev` → `main` (PR triggers CI)
- Hotfixes: `fix/<issue>-<slug>` → merge to `dev`, cherry-pick to `main` if urgent

### Milestones

- Every issue MUST be assigned to a milestone before work begins
- Milestones represent releases or sprint iterations
- Use `gh issue edit <number> --milestone "<milestone-name>"`
- Track milestone progress on the GitHub Milestones page

### Agents

Agent definitions live in `opencode.json` and `.opencode/agents/`:

- **build** (primary): Full development work with all tools enabled
- **plan** (primary): Analysis and planning without making changes
- **backend** (subagent): Implements routes, services, database changes
- **frontend** (subagent): Implements UI components and client-side behavior
- **tester** (subagent): Writes and runs tests
- **reviewer** (subagent): Reviews code for bugs, security, and regressions

### Skills

- `api-design`: Load when working on routes or endpoints
- `docker-dev`: Load when working with Docker containers
- `github-workflow`: Load for git operations and PR conventions

### Linking conventions (mandatory)

Every change must be traceable end-to-end:

| From | To | How |
|------|-----|-----|
| Branch | Issue | Branch name includes issue number: `feat/42-document-chunking` |
| PR | Issue | `Closes #<number>` in PR body |
| PR | Milestone | `gh pr edit <number> --milestone "<name>"` |
| Issue | Milestone | `gh issue edit <number> --milestone "<name>"` |
| Commit | Issue | Conventional commit with issue context |

No orphaned branches, PRs, or issues. Every piece of work is linked.

### Rules for Agents

All workflow rules that agents must follow are documented in this file. When configuring a project, ensure AGENTS.md contains:

- branch strategy and naming conventions;
- CI strategy (which PRs trigger CI, local testing requirements);
- milestone and issue conventions;
- development commands (test, lint, build, format);
- environment and secret-file rules;
- any project-specific constraints or permissions.
