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
(host creds), your opencode config, git identity, `make`, and the Docker CLI
(compose plugin included) — plus the running stack at `:8000` / `:5173`, so
`make check` and end-to-end curls work without leaving the container.

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

## Browser checks (headless Chromium is baked into the dev image)

The dev sandbox ships Playwright's headless Chromium plus Lighthouse, so
accessibility and E2E checks run against the live dev server instead of waiting
on a human with a laptop. Rebuild once after pulling this change:

```bash
make dev-build      # bakes Chromium + its system libs + the two CLIs
make dev-up
```

Screenshot a page from inside the sandbox (ports are internal 8000/5173 there):

```bash
docker compose exec dev playwright screenshot --full-page \
  http://localhost:5173 /tmp/landing.png
docker compose cp dev:/tmp/landing.png ./landing.png   # bring it out to view
```

Lighthouse against the same origin — from the `dev` container, or the host
against the published port 5175. No browser flags needed; `CHROME_PATH` is
already set in the image:

```bash
docker compose exec dev lighthouse http://localhost:5173 \
  --only-categories=accessibility --output=json --output-path=/tmp/lh.json
docker compose exec dev node -e \
  'const r=require("/tmp/lh.json");console.log("accessibility:",r.categories.accessibility.score)'
```

Three things to know:

- **Call `playwright`/`lighthouse` directly, not via `npx`.** Both are installed
  globally in the image. `npx` would resolve them from the npx cache instead,
  which is empty at runtime, so every invocation would quietly re-download from
  npm (and then still fail, because `npx` does not inherit the image's
  `PLAYWRIGHT_BROWSERS_PATH` the way the baked CLI does).
- **Never launch the Chrome-for-Testing binary yourself; use `chrome`.** The
  full browser in this image aborts at startup in its crashpad handler
  (`chrome_crashpad_handler: --database is required` → SIGTRAP), with or
  without `--no-sandbox`. Only the headless shell runs, so `chrome` is a
  wrapper that execs it. Lighthouse reads `CHROME_PATH`, which points at that
  wrapper, so it needs no flags — but if you launch Chrome by hand, use
  `/usr/local/bin/chrome`, not the file under `/opt/ms-playwright`.
- **The wrapper injects `--no-sandbox`, and that is deliberate.** It is *not*
  because the container runs as root (it does not — the runtime user is
  `appuser`); the host has unprivileged user namespaces disabled by AppArmor,
  so Chrome's namespace sandbox is unavailable and it dies with
  `No usable sandbox!`. Every CI runner makes this same trade: browser
  isolation is given up for a working toolchain. If you ever see
  `No usable sandbox!`, you bypassed the wrapper.

`/dev/shm` is raised to 2 GB on the `dev` service (`shm_size` in
`docker-compose.yaml`). Docker's 64 MB default makes Chromium crash on any
non-trivial page, and the failure looks like a browser bug rather than a
memory one.

The browser lives in `/opt/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`), not
`~/.cache`, because the build layer runs as root while the runtime runs as
`appuser` — the default path would bake into `/root` and be invisible at
runtime. It is also read by the `worker` service, which builds from the same
Dockerfile; that is image size only, as the worker never launches a browser.

For ad-hoc DOM measurement, drive Playwright from Node. Global packages are not
on `NODE_PATH`, so require it by absolute path:

```bash
docker compose exec dev node -e '
  const { chromium } = require("/opt/mise/data/installs/node/22.23.3/lib/node_modules/playwright");
  (async () => {
    const b = await chromium.launch();
    const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
    await p.goto("http://localhost:5173", { waitUntil: "networkidle" });
    console.log(await p.title());
    await b.close();
  })();'
```

## Tools

```bash
make setup        # host deps: uv sync + npm install (first clone)
make host-tools   # mise install — kind/kubectl/helm/kustomize/devspace (host)
```

## Migrations

- Sandbox: `alembic upgrade head` runs automatically on `make dev-up`.
- Host-native: `cd backend && uv run alembic upgrade head`.
- New migrations: `cd backend && uv run alembic revision --autogenerate -m "..."`.