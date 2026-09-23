# Contributing to AI Document Intelligence Platform

Thank you for considering contributing! This document covers the essentials for
working on the platform. For the full development-loop cheatsheet see
`DEVELOPMENT.md`; for architecture and environment conventions see
`AGENTS.md` / `PROJECT_CONTEXT.md`.

## Getting started

### Prerequisites

- **Node 22+** and **npm** (frontend)
- **Python 3.14** and **uv** (backend) — never use `pip` directly
- **Docker + Docker Compose** (dev sandbox / infrastructure)
- **gh** (GitHub CLI) — authenticated against the repo
- **make** (workflow targets)

### First-time setup

```bash
make setup          # uv sync + npm install
make infra-up       # start postgres/redis/minio only (host-native path)
```

### Daily loop

Golden rules:

1. `make dev-up` to start the full sandbox → `make dev-log` (2nd terminal) →
   `make dev-down` when done
2. `make check` before every push — always green before opening a PR
3. Only `dev-up` requires opencode; `infra-up` + host loop (`make check`) don't

```bash
make dev-up         # isolated dev sandbox: uvicorn + vite + arq worker + infra
make dev-log        # tail sandbox logs (2nd terminal)
make dev-down       # stop the sandbox (keeps volumes)
make check          # lint (ruff + oxlint) + tests (pytest + vitest) + build
```

Backend tests need the infra services up (`make infra-up`) because they run
against a real PostgreSQL.

## Branch strategy

```text
main          ← release merges (CI runs here)
  └── dev     ← integration branch (all feature branches merge here)
        ├── feat/<issue>-<slug>
        ├── fix/<issue>-<slug>
        └── refactor/<issue>-<slug>
```

- Branch from `dev` — never push directly to `dev` or `main`
- Branch naming: `<type>/<issue-number>-<slug>` (e.g. `feat/42-document-chunking`)
- Branch types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`, `ci/`
- Release merges (`dev` → `main`) are user-initiated only

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`.

Reference the issue in the commit body for traceability (e.g. `Closes #42`).

## Pull request workflow

Every change is tracked end-to-end on GitHub: **issue → branch → PR → merge**.

1. **Create a GitHub issue** first (assigned + labeled per the mapping below)
2. **Create a feature branch** from `dev` that implements exactly that issue
3. **Open a PR** to `dev` linked to the issue with `Closes #<issue-number>`
4. **Run `make check` locally** before pushing — CI only runs on `dev` → `main`
   PRs, so local testing is your gate
5. One feature per PR — never bundle unrelated changes
6. Do not merge PRs unless explicitly instructed

### Label mapping

| Commit type | GitHub label |
|-------------|--------------|
| `feat`      | `enhancement` |
| `fix`       | `bug` |
| `chore`     | `chore` |
| `refactor`  | `refactor` |
| `docs`      | `documentation` |
| `test`      | `test` |
| `ci`        | `ci` |

### Milestones

Every issue must be assigned to a milestone before work begins. Milestones
represent releases or sprint iterations.

## Testing

```bash
make test          # backend (pytest) + frontend (vitest)
make test-backend  # cd backend && uv run pytest
make test-frontend # cd frontend && npm test
make lint          # ruff (backend) + oxlint (frontend)
make build         # frontend typecheck + production build
```

- Tests are mandatory for new features and bug fixes
- Mock external services (OpenAI, MinIO) — never call real APIs in tests
- Backend tests: `backend/tests/`, pytest, fixtures in `conftest.py`
- Frontend tests: colocated `*.test.ts(x)` beside the source file, Vitest +
  Testing Library

## Reporting bugs

Open a GitHub issue using the bug-report template. Include: steps to reproduce,
expected vs. actual behavior, environment details, and logs if available.
For security vulnerabilities, follow the process in `SECURITY.md` — do not open
a public issue.

## Getting help

- `DEVELOPMENT.md` — daily-loop cheatsheet (start/stop, tests, sandboxed agent)
- `AGENTS.md` — full development guidelines and workflow
- `PROJECT_CONTEXT.md` — product, architecture, and API documentation