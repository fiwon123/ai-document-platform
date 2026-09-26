# DEVELOPMENT.md — Daily-Loop Cheatsheet

The dev environment is a lightweight Docker "dev sandbox" (no VS Code Dev
Containers). The workspace is a single shared source of truth: a bind-mount
between the host and the `dev` container — you, the AI coding agent, and the
running app all see the same files. This cheatsheet covers the daily loop. Full
architecture and conventions live in `AGENTS.md` / `PROJECT_CONTEXT.md`.

## Host identity and bind mounts

The `dev` and `worker` services run as the host developer's UID/GID. Files
created in the shared workspace by opencode, npm, Python, or migrations are
therefore editable in VS Code without `sudo`. The trusted `dev` service also
receives the host Docker socket's group so the sandboxed agent can use Docker.

Use the Make targets below: they export `HOST_UID`, `HOST_GID`, `HOST_HOME`,
`HOST_PROJECT_DIR`, and `DOCKER_GID` automatically, and their startup targets
pass `--build` so a stale image cannot carry another user's identity. If
invoking `docker compose` directly, export the same values and build before
starting (the defaults target the common UID/GID 1000 setup). On Fedora/Linux,
for example:

```bash
export HOST_UID="$(id -u)"
export HOST_GID="$(id -g)"
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker compose up --build dev worker
```

The running `dev` service receives `HOST_HOME` and `HOST_PROJECT_DIR` as
well, so an agent invoking Docker Compose from inside the sandbox still sends
host paths to the host Docker daemon. The values also let Make derive the host
identity from the workspace owner when invoked inside an existing sandbox.
The sandbox targets refuse UID 0 so an unrepaired root-owned checkout cannot
silently recreate the original problem. On macOS, use `stat -f '%g'` for
`DOCKER_GID` when necessary.

The first run after upgrading from the old root-running sandbox may need a
one-time ownership repair for files already created by root:

```bash
sudo chown -R "$(id -u):$(id -g)" .
```

Run it from the repository root once, then use the normal non-root sandbox
workflow. This repair is not needed on a fresh clone.

## Golden rules

1. `make dev-up` to start → `make dev-log` (2nd terminal) → `make dev-down` when done
2. `make check` before every push — always green before PR
3. Only `dev-up` requires opencode; `infra-up` + host loop (`make check`) don't

> Rule 3 in practice: the **sandbox-starting** targets run the preflight and
> need the host opencode binary — `dev-up`, `dev-restart`, `opencode`,
> `sandbox`. Everything else (including `make check`) never does.

## Architecture at a glance

```
You (host editor)  ──edit──▶  workspace (bind mount)
                                   │  hot reload (uvicorn --reload + vite HMR)
                                   ▼
docker compose up dev  ──▶  dev (uvicorn :8000 + vite :5173)
                           worker (arq document processor)
                           postgres (:5432) · redis (:6379) · minio (:9000)
```

opencode (the AI coding agent) can run **on the host** or **inside the `dev`
container** (`make opencode`). Both see the same files.

## Start / stop

```bash
make dev-up        # START: build/cache-check + dev + worker + postgres + redis + minio
                    # foreground with combined logs — Ctrl+C stops it
make dev-log       # tail the dev sandbox logs (uvicorn + vite; worker: compose logs -f worker)
make dev-down      # STOP: tear down the stack (postgres data volume kept)
make dev-restart   # RESTART: down + up --build in one step, data still there
make infra-up      # infra only (postgres/redis/minio) for the host-native loop
make infra-down    # stop infra only

docker compose down -v    # ONLY to wipe the database + Redis + MinIO too
```

- Host ports: frontend `:5175`, backend API `:8001` (docs at `/docs`), postgres
  `:5434`, redis `:63790`, MinIO console `:9001`. Inside the `dev` container the
  stack is reachable at `:8000` / `:5173`.
- `make dev-up` requires the opencode binary (`${HOME}/.opencode/bin/opencode`);
  install with `curl -fsSL https://opencode.ai/install | bash`. It pre-creates
  `~/.config/opencode` and `~/.gitconfig` (mounted read-only into the container).

## Code with AI — sandboxed (recommended)

```bash
make opencode         # → the AI coding agent TUI inside the dev container
                      #   (runs `opencode --auto`: permission prompts are
                      #   auto-approved — the sandbox is trusted by design)
```

`--auto` is the default; override per-invocation:

```bash
make opencode OPENCODE_ARGS=""                          # bare TUI (prompts back)
make opencode OPENCODE_ARGS="--auto -m provider/model"  # pick a model
make opencode OPENCODE_ARGS="run 'task' --auto"         # one-shot non-interactive
```

Or open a plain shell first, then start the agent yourself:

```bash
make sandbox          # interactive bash inside the dev container
cd /sandbox/ai-document-platform && opencode
```

One-shot mode without a shell (TTY-aware — interactive commands keep a TTY,
piped stdin uses `-T`):

```bash
scripts/open-in-sandbox.sh 'uv run pytest'
```

Inside the sandbox the agent has node 22, uv (+ baked `/opt/backend-venv`), gh
(working auth, see below), your opencode config, git identity, `make`, and the
Docker CLI (compose plugin included) — plus the running stack at `:8000` / `:5173`,
so `make check` and end-to-end curls work without leaving the container.

#### GitHub auth inside the sandbox

`gh` authenticates from a `GH_TOKEN` **environment variable**, not from the
read-only `~/.config/gh` mount. That mount is not enough on its own: your host
token usually lives in the OS **keyring**, so `hosts.yml` carries no
`oauth_token` key, and the container has no keyring socket. Without the token
variable the sandbox's `gh` is unauthenticated — silently, because the config
mount still *looks* right.

`make dev-up` (and `make dev-restart` / `dev-exec` / `opencode` / `shell`) resolve
the credential from your host's *active* `gh` login via
`scripts/resolve-gh-token.sh` and pass it into the `dev` service. Resolution
order: `$GH_TOKEN` → `$GITHUB_TOKEN` → `gh auth token` (keyring / `hosts.yml`).

A **rejected** token aborts the start with an actionable error. This matters
because an expired `GH_TOKEN` in your shell takes precedence over your keyring
login in `gh`, and therefore also breaks `gh` and `git` on the host (git delegates
to `gh auth git-credential`):

```bash
gh auth status          # if this reports an invalid token, that is the cause
unset GH_TOKEN GITHUB_TOKEN
gh auth status          # now uses the keyring credential
```

An **absent** credential only warns — the sandbox still starts, `gh` just is not
authenticated. An **unreachable** GitHub also only warns, so being offline never
blocks `make dev-up`. To pin a specific token: `make dev-up GH_TOKEN=<pat>`.

> One cosmetic artifact: `gh auth status` inside the container also lists the
> mounted `hosts.yml` account as invalid, because that account has no token
> attached. It is inactive — `GH_TOKEN` takes precedence and is the one that works.

> Trusted-agent model: the dev container shares the workspace bind-mount, the
> host Docker socket, gh auth, and opencode config with the host by design.
> Isolation covers the agent's runtime, not Docker/workspace access — the same
> trust granted to opencode on the host. The `worker` service receives none of
> these mounts.

## Code with AI — on the host (fallback)

```bash
make infra-up             # infra services only (detached)
cd backend && uv run uvicorn app.main:app --reload   # backend on :8000
cd frontend && npm run dev                           # vite on :5173
make check                # lint + tests + build (no containers needed)
```

## Tests / lint / build (host-native — no sandbox required)

```bash
make check        # = lint (ruff + oxlint) + tests (pytest + vitest) + build
make test         # test-backend (pytest) + test-frontend (vitest)
make lint         # ruff + oxlint
make build        # frontend typecheck + production build
```

- Backend tests need `postgres`/`redis`/`minio` up (`make infra-up`).
- Known pre-existing failure: `test_metrics_endpoint_exposes_process_and_http_metrics`
  (worker heartbeat invisible to the test Redis DB — 231/232 pass). Unrelated to
  app code; tracked as a separate fix.
- Existing root-owned files from pre-migration sandboxes are covered by the
  one-time repair above; new sandbox writes use the host developer's ownership.

## Tools

```bash
make setup        # host deps: uv sync + npm install (first clone)
make host-tools   # mise install — kind/kubectl/helm/kustomize/devspace (host)
```

## Migrations

- Sandbox: `alembic upgrade head` runs automatically on `make dev-up`.
- Host-native: `cd backend && uv run alembic upgrade head`.
- New migrations: `cd backend && uv run alembic revision --autogenerate -m "..."`.