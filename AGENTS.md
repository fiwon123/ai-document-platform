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
- Development: Docker Compose dev sandbox (uvicorn + vite + arq worker), mise for tools, Makefile-driven

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
Dockerfile     # Dev image (uvicorn/vite/worker runtime, deps baked)
docker-compose.yaml  # dev + worker + postgres + redis + minio
dev-entrypoint.sh    # Foreground uvicorn + vite with hot reload
Makefile       # Dev workflow targets (dev-up, infra-up, test, check, ...)
mise.toml      # Tool versions (node/uv/gh + host k8s toolchain)
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

### Development Loop (Makefile)

```bash
make setup                # Host-native deps (uv sync + npm install)
make infra-up             # Start only postgres/redis/minio
make dev-up               # Isolated dev sandbox: uvicorn + vite + arq worker + infra
make dev-log              # Tail dev sandbox logs
make dev-build            # Rebuild the dev image (after pyproject/uv.lock changes)
make dev-down             # Stop the sandbox (keeps volumes)
make reset                # Stop everything and wipe volumes (clean slate)
make check                # Full local gate: lint + tests + build
```

### Docker Compose (dev sandbox)

The stack has five services: `dev` (uvicorn + vite, foreground, hot reload),
`worker` (arq document processor), `postgres`, `redis`, `minio`.

```bash
# Start the full isolated dev sandbox (dev + worker + infra)
# From the host, use make so UID/GID and host paths are derived automatically:
make dev-up
# Direct Compose users must export HOST_UID/HOST_GID/DOCKER_GID first:
docker compose up --build dev worker

# Start only infrastructure services (host-native path)
docker compose up -d postgres redis minio

# View logs
docker compose logs -f dev
docker compose logs -f worker

# Shell inside the sandbox
docker compose exec dev zsh

# Stop all services / wipe volumes (clean slate)
docker compose down
docker compose down -v
```

### Golden rules

1. `make dev-up` to start → `make dev-log` (2nd terminal) → `make dev-down` when done
2. `make check` before every push — always green before PR
3. Only `dev-up` requires opencode; `infra-up` + host loop (`make check`) don't
4. **UI changes are verified by looking at them.** Captures are part of the gate,
   not an optional extra — see `.opencode/instructions/testing.md` → "Visual checks"

## Runtime Environment

Two equivalent loops, same files (bind-mounted workspace):

- **Sandboxed (recommended)**: opencode runs INSIDE the `dev` container —
  `make opencode` (agent TUI), `make sandbox` (plain shell) or
  `scripts/open-in-sandbox.sh`. The container mounts the host opencode binary
  + config, git identity, gh auth, and the Docker socket (trusted-agent
  model — see `DEVELOPMENT.md`); it has `make`, git, node/uv/gh, the baked
  `/opt/backend-venv`, and the running stack at `:8000`/`:5173`.
- **Host-native (fallback)**: the agent runs natively on the host, edits the
  repo directly, and drives the sandbox via `make`/`docker compose`.

### Docker CLI availability

- `docker` / `docker compose` **are available** — the sandbox is managed with
  plain compose commands (see Makefile targets). No devcontainer, no
  forwarded-port indirection, and no network-pinning workarounds.
- Infrastructure services (PostgreSQL, Redis, MinIO) run as compose services
  and are reachable on `localhost` via their host ports (see below).
- The `dev` image ships the static Docker CLI + compose plugin, and the
  `dev` service mounts the host Docker socket — so the sandboxed agent can
  drive Docker/compose from inside. The `worker` service gets neither.

### What the agent CAN do

- Run backend commands: `uv`, `python`
- Run frontend commands: `npm`, `npx`, `node`
- Run git commands: `git`, `gh`
- Drive the dev sandbox: `make dev-up`, `make dev-log`, `docker compose exec dev zsh`, ...
- Run sandboxed coding sessions: `make opencode` (agent inside the dev
  container — same files via the bind mount, stack at `:8000`/`:5173`)
- Run the host-native loop: `make infra-up`, then uvicorn/vite directly

### gh CLI Authentication

- `gh` authenticates via the host's default credential flow (`gh auth login`
  or `gh auth login --with-token`), because the agent runs natively on the
  host — no `remoteEnv` forwarding or config volumes needed.
- The `dev` container mounts `~/.config/gh` read-only, so the sandboxed agent
  has the same gh auth (issues/PRs land on the host tree via the bind mount).
- **One-time setup** (already done on this machine): `gh auth login` or set a
  `GITHUB_TOKEN` with scopes `repo, read:org, workflow`. Use
  `gh auth status` to verify.

### Service ports (published from compose to the host)

Container-internal ports stay at the standard values (5432, 6379, 8000,
5173); host ports are offset to avoid conflicts with other local projects:

- PostgreSQL: `localhost:5434`
- Redis: `localhost:63790`
- MinIO API: `localhost:9000` / Console: `localhost:9001`
- Backend API: `localhost:8001` (dev service → container port 8000)
- Frontend Dev: `localhost:5175` (dev service → container port 5173)

Inside the `dev` container uvicorn and vite share one network namespace, so
the Vite proxy default (`http://localhost:8000`, vite.config.ts) works
without extra config. In the host-native loop the same default proxies to the
host uvicorn.

### What the agent CANNOT do

- Nothing container-related is off-limits: the Docker **daemon** runs on the
  host, and `docker`/`docker compose` are used as normal CLI tools — either
  from the host (host-native loop) or from inside the dev container
  (sandboxed agent; the `dev` service mounts the host socket).
- The `worker` service gets no docker socket and no opencode/gh mounts — only
  the `dev` container carries the trusted-agent model.

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

### Dev Sandbox

- Services run in Docker Compose: `dev` (uvicorn + vite, hot reload) +
  `worker` (arq) + `postgres` + `redis` + `minio`
- Published ports: 8001 (API), 5175 (Vite dev server), 5434/63790/9000/9001 (infra)
- Backend deps are baked into `/opt/backend-venv` at image build (no per-start
  `uv sync`, no startup memory spike); rebuild with `make dev-build` after
  `pyproject.toml`/`uv.lock` changes
- Migrations run in `dev-entrypoint.sh` (`alembic upgrade head`) before uvicorn
  starts; the `worker` service is gated on `dev` healthy so it never polls the
  queue before the schema exists
- The `dev` container additionally carries the sandboxed AI coding agent:
  host opencode binary + config, git identity, and gh auth are mounted
  read-only; the host Docker socket is mounted too (RW by design — trusted-agent
  model, see `DEVELOPMENT.md`). Run the agent inside with `make opencode` (runs
  `opencode --auto` by default — permission prompts auto-approved; override
  with `make opencode OPENCODE_ARGS="..."`) or `make sandbox`.

## Environment Variables

Backend reads from `backend/src/app/.env` (gitignored):
- `POSTGRES_*`: Database connection (defaults: `localhost:5434/mydb`)
- `REDIS_*`: Redis connection (defaults: `localhost:63790`)
- `MINIO_*`: S3-compatible storage (defaults: `localhost:9000`, bucket: `documents`)
- `DATABASE_URL`: Full PostgreSQL URL (used by Alembic)
- `SECRET_KEY`: JWT signing key (required)
- `ALGORITHM`: JWT algorithm (default: HS256)

### The dev sandbox reads a different file

`docker-compose.yaml` sets the whole `dev`/`worker` environment inline, so
`backend/src/app/.env` is **not** read inside the sandbox. LLM provider config
comes from a **gitignored root `.env`** (or a shell export) instead, substituted
into `${VAR:-...}` by Compose: `OPENAI_API_KEY`, `GROQ_API_KEY`, `QA_MODEL`,
`QA_MAX_TOKENS`, `GROQ_REQUESTS_PER_MINUTE`, `GROQ_TOKENS_PER_DAY`,
`PROVIDER_QUOTA_ENABLED`, `OPENAI_MODEL`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMENSIONS`,
`LOCAL_LLM_ENABLED`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`,
`LOCAL_EMBEDDING_MODEL`, `LOCAL_EMBEDDING_DIMENSIONS`, `OPENAI_BASE_URL`. See
`DEVELOPMENT.md` → *LLM provider config in the sandbox*.

Both services also map `host.docker.internal:host-gateway`, which is what lets the
container reach a model server bound to the host (`LOCAL_LLM_BASE_URL` pointing at
a host-side Ollama). Docker Desktop provides that name on its own; plain Linux
Docker does not, and `backend/tests/test_compose_env.py` fails if the mapping is
removed.

Each Compose default is the application's own default on purpose: `load_dotenv()`
does not override real environment variables, so an empty value passed from
Compose beats both `backend/src/app/.env` and the `os.getenv` fallback
(`EMBEDDING_MODEL=""` would 400 on every embeddings call). `backend/tests/test_compose_env.py`
fails if the two lists drift apart.

One Compose default deliberately is not the application default:
`ALLOW_PLACEHOLDER_SECRET_KEY: ${ALLOW_PLACEHOLDER_SECRET_KEY:-1}` on the `dev`
and `worker` services. The app refuses to start on the signing key committed to
this repository (#524), so the dev sandbox — the one environment where a
published key is knowingly fine — acknowledges it explicitly instead of the check
being weakened to accommodate it. It is set in no other shipped config; staging
inherits the same base Secret and must supply a real key.
`backend/tests/test_published_key_deployment.py` pins which environments set it,
and that every key published anywhere in the repo is one the guard refuses.

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
- GitHub Actions CI runs lint + build on `dev` → `main` PRs (`.github/workflows/ci.yml`),
  label-gated and **not on any other trigger** — see *CI triggers* below
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
  (or a manual dispatch), never on a push to `dev`
- Do NOT merge pull requests unless explicitly instructed
- Do NOT automatically create release PRs or merge to main — user must explicitly request
- Always return to `dev` branch after completing any merge
- Every change is tracked on GitHub: **issue → branch → PR → merge**

### CI triggers (read this before claiming a change is verified)

Both workflows are **label-gated `dev`→`main` PRs plus manual dispatch**. A push
to `dev` triggers neither, and a `dev` push is not a CI event at all:

| Workflow | Runs on |
|---|---|
| `ci.yml` — backend tests + ruff, frontend lint/build/tests | `ci`-labelled PR to `main`, or `workflow_dispatch` |
| `infra.yml` — kustomize/helm/kubeconform, image builds → ghcr.io, Kind smoke test | `ci`-labelled PR to `main`, or `workflow_dispatch` |

So a feature branch is **unverified** until the release PR is opened and
labelled, or someone dispatches the workflow. A change touching `infra/**`
receives no `kustomize build`, `helm lint` or `kubeconform` anywhere on its way
to `dev` — validate it locally first (`DEVELOPMENT.md` → *Validating infra
locally*). Publishing images to ghcr.io on every dev push is deliberately
avoided; the validation that *should* have covered it is a separate concern from
the release publish, and conflating them is what let the gap go unnoticed.

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

- **build** (primary): Full development work with all tools enabled — `opencode/big-pickle`
- **plan** (primary): Analysis and planning without making changes — `opencode/nemotron-3-ultra-free`
- **visual** (primary + subagent, yellow): Looks at screenshots/GIF/video of the
  running app and reports or fixes what is visually wrong —
  `opencode/mimo-v2.6-flash-free`. This is the only reason a visual claim is
  allowed: the agent is multimodal, so "look at the capture" is a step, not an
  inference. `mode: "all"` on purpose — you can Tab into it to review a page
  directly, *and* `build` delegates to it via the Task tool for the
  visual-verification step. `subagent` would make it invisible in the mode
  switcher (#531)
- **backend** (subagent): Implements routes, services, database changes
- **frontend** (subagent): Implements UI components and client-side behavior
- **tester** (subagent): Writes and runs tests
- **reviewer** (subagent): Reviews code for bugs, security, and regressions

Model and `mode` per role are in `opencode.json` **and** mirrored in
`.opencode/agents/*.md`; the two are duplicated today, so change both — a `mode`
that differs between them is a role that silently does not appear. `color`
accepts `#RRGGBB` or `primary|secondary|accent|success|warning|error|info` — a
bare `"yellow"` is rejected and would break startup. Verify model ids with
`opencode models`. Config is read once at startup: after changing it, restart
opencode — a running session keeps the agent list it loaded with.

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
