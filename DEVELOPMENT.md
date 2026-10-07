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

`make opencode`, `make sandbox`/`make shell`, and `make dev-exec` bring the stack
up only if it is not already running — they **do not rebuild** a sandbox that is
already up, so you can call them right after `make dev-up` / `make dev-restart`
without kicking off a second build that races the live one. The build happens
only when the sandbox was never initialized, or when you ask for it explicitly
with `make dev-build` (needed after changing `Dockerfile`, `pyproject.toml`, or
`uv.lock`). If the stack is still starting, they wait for it to become healthy
instead of starting a competing one.

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
make check                # lint + format + tests + build (no containers needed)
```

## Tests / lint / build (host-native — no sandbox required)

```bash
make check        # = lint (ruff + oxlint) + format (oxfmt) + tests (pytest + vitest) + build
make test         # test-backend (pytest) + test-frontend (vitest)
make lint         # ruff + oxlint
make format       # ruff format (backend) + oxfmt (frontend)
make format-check # oxfmt --check — the frontend formatting gate `make check` runs
make build        # frontend typecheck + production build
```

- Backend tests need `postgres`/`redis`/`minio` up (`make infra-up`).
- Known pre-existing failure: `test_metrics_endpoint_exposes_process_and_http_metrics`
  (worker heartbeat invisible to the test Redis DB — 231/232 pass). Unrelated to
  app code; tracked as a separate fix.
- Existing root-owned files from pre-migration sandboxes are covered by the
  one-time repair above; new sandbox writes use the host developer's ownership.

### The backend suite drops tables — never point it at real data

The backend suite calls `create_all` and `drop_all` on the engine it is given,
so **whatever database it connects to, it empties.** It targets `mydb_test`.

Run it normally. No override is needed, inside the sandbox included:

```bash
cd backend && uv run pytest
```

`tests/conftest.py` forces `DATABASE_URL` to the test database before importing
any app module, because `app/database/db.py` resolves `DATABASE_URL` **first**
and falls back to the `POSTGRES_*` parts only when it is unset. The dev sandbox
exports `DATABASE_URL` pointing at `mydb`, so isolation via `POSTGRES_DB` alone
was inert there — every full-suite run inside the container emptied the
development database, silently, while still reporting green (#683).

`_assert_test_database` refuses to start if the engine is connected to anything
other than the test database, **or** if `TEST_DB_NAME` names the database the
application itself uses. If you ever see:

```text
RuntimeError: Refusing to run: the test engine is bound to database 'mydb', expected 'mydb_test'.
```

you are one step from deleting real data, and the suite stops instead of doing it.

### Recovering a database the suite emptied

The damage is recognisable and total: `alembic_version` survives while every app
table is gone, because `drop_all` only drops tables in `Base.metadata` and
`alembic_version` is not one.

**`alembic upgrade head` will not fix it** — Alembic reads the stamp, concludes
it is already at head, and applies nothing. Restarting the sandbox will not fix
it either.

Clear the surviving objects, then migrate for real:

```bash
cd backend
uv run python -c "
from sqlalchemy import text
from app.database.db import engine
with engine.begin() as c:
    c.execute(text('DROP TABLE IF EXISTS alembic_version CASCADE'))
    for t in ('role', 'documentstatus'):
        c.execute(text(f'DROP TYPE IF EXISTS {t} CASCADE'))
"
uv run alembic upgrade head
```

**The enum types are required, not optional.** `drop_all` drops *tables* from
`Base.metadata`; Postgres enum types are not tables, so `role` and
`documentstatus` survive alongside `alembic_version` — as does anything else a
migration created outside `Base.metadata`. Migration 001 then runs
`CREATE TYPE role AS ENUM (...)` against a type that already exists and aborts:

```text
[SQL: CREATE TYPE role AS ENUM ('customer', 'admin')]
(Background on this error at: https://sqlalche.me/e/20/f405)
```

`CREATE TYPE` is not idempotent, unlike `CREATE TABLE IF NOT EXISTS`, so a
surviving type is a hard failure rather than a skipped step. Any future migration
that creates an object outside `Base.metadata` needs adding to that loop.

> **Dropping the stamp first is one-way.** If `alembic upgrade head` then fails,
> there is no stamp left to migrate from. Check for surviving objects first:
> ```bash
> uv run python -c "
> from sqlalchemy import text
> from app.database.db import engine
> with engine.connect() as c:
>     print('tables', [r[0] for r in c.execute(text(\"select tablename from pg_tables where schemaname='public' order by 1\"))])
>     print('enums ', [r[0] for r in c.execute(text(\"select typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e' order by 1\"))])
> "
> ```
> In the emptied state this prints `tables ['alembic_version']` and
> `enums ['documentstatus', 'role']` — the types with no table beside them are
> the leftovers to drop. When in doubt, or on a database where you do not need
> anything, reset the schema outright:
> ```bash
> uv run python -c "
> from sqlalchemy import text
> from app.database.db import engine
> with engine.begin() as c:
>     c.execute(text('DROP SCHEMA public CASCADE'))
>     c.execute(text('CREATE SCHEMA public'))
> "
> uv run alembic upgrade head
> ```

Verify afterwards — you want 7 tables and the stamp at `010`:

```bash
uv run alembic current
```

Anything the database held is gone. In a dev sandbox that is usually nothing;
anywhere else it is data loss, so treat it as the incident it is.

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

## LLM provider config in the sandbox

The host-native loop reads `backend/src/app/.env`. The sandbox does **not** — it
gets its environment from `docker-compose.yaml`, which passes the provider
variables through. Put them in a **gitignored root `.env`** (Compose reads the
project `.env` for `${...}` substitution), or export them in your shell before
`make dev-up`. Either way `docker-compose.yaml` needs no edit:

```bash
# ./.env  (gitignored — never commit keys)
GROQ_API_KEY=gsk_...                     # free tier, console.groq.com
QA_MODEL=openai/gpt-oss-120b             # optional: pin the default model
```

`QA_MODEL` is optional. Left unset, the app picks the first **free** model whose
provider is actually configured — Groq before local, and a paid OpenAI model only
when nothing free is available. `openai/gpt-oss-120b` is that free-first default:
Groq's best free-tier answer quality, with the deepest daily token allowance of
the free roster. Pin it only to override.

Then `make dev-restart` (variables are read at process start, so a running
container keeps the old environment). Confirm with `GET /v1/qa/models`, where
each model reports `available`.

### Using a local model (Ollama) — dev and testing

The local provider is the only path that needs **no API key at all**, which makes
it the cheapest way to exercise the whole QA pipeline. It needs three things, and
all three are required — missing any one fails silently by falling back to
another provider.

```bash
# ./.env  (gitignored)
LOCAL_LLM_ENABLED=true
LOCAL_LLM_BASE_URL=http://host.docker.internal:11434/v1
LOCAL_LLM_MODEL=tinyllama
QA_MAX_TOKENS=200                        # see the CPU note below
```

**1. The container must be able to resolve the host.** `host.docker.internal` is
injected by Docker Desktop automatically; plain Linux Docker does not do that, so
`docker-compose.yaml` maps it explicitly:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

It is declared on both the `dev` and `worker` services, and
`tests/test_compose_env.py` fails if it is removed — otherwise the hostname stops
resolving with `Could not resolve host: host.docker.internal`, which reads like a
provider problem but is a networking one. If you hit that error, the mapping is
the first thing to check.

**2. The daemon must listen on a non-loopback address.** The default
`127.0.0.1:11434` is unreachable from a container even with the hostname mapped,
because it only accepts connections from the host's own loopback. Ollama reads
this at **startup**, so it is a *daemon* setting, not an application one — it
belongs in a systemd drop-in, **not** in the app's `.env`:

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_NUM_THREADS=2"
```

Then apply it and confirm the address actually changed:

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
ss -tlnp | grep 11434      # must show 0.0.0.0:11434, not 127.0.0.1:11434
```

> **Ollama's API has no authentication.** `0.0.0.0` publishes a
> model-execution endpoint to every host on your network. On a shared or
> untrusted network, put a firewall rule in front of port 11434 or bind it to a
> specific interface instead. `OLLAMA_NUM_THREADS` caps CPU use for the daemon;
> raising it beyond your core count slows generation rather than speeding it up.

If a request fails with an invalid-hostname error, Ollama's DNS-rebinding
protection rejected the container's `Host` header. Add `OLLAMA_ORIGINS=*` to the
same drop-in.

**3. Expect it to be slow, and lower the answer cap.** A 1B model on CPU-only
threads is for proving the wiring works, not for judging answer quality.
Measured on an Ollama host at `OLLAMA_NUM_THREADS=2`:

| model | throughput | a 1000-token answer takes |
|---|---|---|
| `tinyllama` | 3.2 tok/s | ~5 min |
| `qwen2.5-coder:1.5b` | 2.6 tok/s | ~6 min |

Throughput falls with host load: the same `tinyllama` call that took 13 s for 13
tokens (~1 tok/s) on an otherwise busy machine. Treat the table as an idle-host
figure and size `QA_MAX_TOKENS` for the machine you are on — a QA round trip
that feels like a hang is usually this, not a broken provider.

`QA_MAX_TOKENS` (default `1000`) bounds this; set it to `200` or less locally.
It is read once at startup, so it also needs `make dev-restart`.

**A local model server can provide embeddings too.** `embedding.py` resolves one
active space: `OPENAI_API_KEY` wins, and only when it is absent does
`LOCAL_LLM_ENABLED` select the local space. Ollama serves both chat and
embeddings, so a zero-cost setup gets real semantic search — pull the embedding
model once, or the worker's embedding call fails and the document ends
`failed`:

```bash
ollama pull nomic-embed-text
```

`LOCAL_EMBEDDING_MODEL` / `LOCAL_EMBEDDING_DIMENSIONS` must agree with the model:
`nomic-embed-text` is 768-wide, `all-minilm` 384, `mxbai-embed-large` 1024. A
mismatch is refused loudly (`EmbeddingDimensionMismatch`) instead of being
stored, because the local column is unconstrained and a mixed-width column makes
the *query* fail rather than the insert.

With **no** provider at all, search reports `mode: keyword` — PostgreSQL
full-text ranking instead of pgvector — and QA answers from whatever keyword
matching surfaced. That is fine for testing the pipeline end to end, but
retrieval quality is then limited by the keyword fallback rather than by the chat
model, so do not read a weak local answer as a QA-quality problem.

### Provider configuration in production (Kubernetes)

The same variables are settable in the Helm chart and the Kustomize base, so the
local and hosted paths are not sandbox-only:

| Variable | Helm (`config.ai.*`) | Kustomize base |
|---|---|---|
| `QA_MODEL` | `qaModel` | `QA_MODEL` |
| `QA_MAX_TOKENS` | `maxTokens` | `QA_MAX_TOKENS` |
| `LOCAL_LLM_ENABLED` | `localLlm.enabled` | `LOCAL_LLM_ENABLED` |
| `LOCAL_LLM_BASE_URL` | `localLlm.baseUrl` | `LOCAL_LLM_BASE_URL` |
| `LOCAL_LLM_MODEL` | `localLlm.model` | `LOCAL_LLM_MODEL` |
| `EMBEDDING_MODEL` | `embeddingModel` | `EMBEDDING_MODEL` |
| `EMBEDDING_DIMENSIONS` | `embeddingDimensions` | `EMBEDDING_DIMENSIONS` |
| `LOCAL_EMBEDDING_MODEL` | `localEmbedding.model` | `LOCAL_EMBEDDING_MODEL` |
| `LOCAL_EMBEDDING_DIMENSIONS` | `localEmbedding.dimensions` | `LOCAL_EMBEDDING_DIMENSIONS` |

A pod's `localhost` is the pod itself, so a pod cannot reach a model server on
the host the way the dev container can: point `LOCAL_LLM_BASE_URL` at an
in-cluster Service, a node IP, or a Gateway — not `127.0.0.1`. That applies to
the local embedding space too, since it uses the same server and base URL.

### Two more things worth knowing

- **`OPENAI_BASE_URL` redirects embeddings *and* the OpenAI QA provider.** It is
  the OpenAI SDK's own environment default, not a project feature, which is why
  `embedding.py` never mentions it — it also happens to be the cleanest way to
  point both at a local OpenAI-compatible server or a test stub.
- **Unset means the app's own default, not empty.** Each variable's Compose
  default mirrors the `os.getenv` fallback in the code, because
  `load_dotenv()` does not override real environment variables — an empty value
  passed from Compose would win over `backend/src/app/.env` and over the code's
  fallback. `tests/test_compose_env.py` pins the two lists together.

A typical free-tier production setup is `GROQ_API_KEY` for chat plus
`OPENAI_API_KEY` for embeddings; see the `QA_MAX_TOKENS` note above for why
hosted providers do not need a lowered cap. To avoid an OpenAI embedding bill
entirely, run Ollama in-cluster and leave `OPENAI_API_KEY` unset, so both the
chat and the embedding space are local.

## Interactive visual audit (`scripts/audit.mjs`)

One command photographs every meaningful interactive state of the app and
records its animations, then prints the handful of numbers worth acting on. It
exists because "the page looked fine" is not evidence, and because an audit
that silently captures the wrong page is worse than none.

```bash
docker compose exec dev node scripts/audit.mjs                  # everything
docker compose exec dev node scripts/audit.mjs --only=documents # one group
docker compose exec dev node scripts/audit.mjs --help
```

### Which browser it uses

Playwright is installed globally in the image and is **not** declared in
`scripts/package.json` — the project uses Vitest and this is a one-off tool — so
the baked browsers under `/opt/ms-playwright` belong to that global install. The
audit therefore resolves a Playwright that can actually launch: a local install
is preferred, but it is only accepted if its browser is on disk, and the global
one is used otherwise. A full pass is slow enough that silently capturing with the
wrong browser would be worse than failing, so the first log line names what it
resolved:

```
[audit] playwright       v1.63.0 (global, chromium-1243)
```

An `import("playwright")` that *succeeds* is not proof of a usable install — a
stale copy resolves fine and then dies at launch, which is what #529 was. If the
resolution ever fails, the error names every install it found, the revision each
one wants and the revisions the image actually has. The rule and its tests live
in `scripts/audit-playwright.mjs`.

It registers its own throwaway user, seeds four documents (ready, ready, ready,
and a deliberately corrupt PDF so the failure card is real), waits for the
worker, then walks the route groups. Output lands in
`frontend/visual-audit/<timestamp>/` with a `summary.json` and an
`audit-manifest.json` that has one entry per capture.

**Open it straight from the host.** The captures land inside the bind-mounted
workspace, so `frontend/visual-audit/<timestamp>/` in your editor or file manager
*is* the run — screenshots and WebMs both. It used to be written to
`/tmp/opencode/visual-audit`, which meant a `docker compose cp` before you could
look at anything and lost every run on a container restart. The directory is
gitignored (37 MB per pass is not a diff anyone wants), and the tool keeps the
newest 3 runs, so it does not grow without bound.

```bash
# what's in the newest run
ls frontend/visual-audit/                        # three timestamped runs
xdg-open "frontend/visual-audit/$(ls -1 frontend/visual-audit | tail -1)/"
```

Budget and retention: 500 MB per run (a hard stop, with GIF conversion checked
before it can overshoot), the newest 3 runs kept, and Playwright's raw
`.video-tmp` scratch directory removed at the end. Manifest and summary bytes
count against the budget too, since they are what a reviewer opens first — and
the figure inside `summary.json` is rewritten to include them, so the number in
the file matches the number in the console.

### The GIFs (`scripts/sequence-gif.mjs`)

A run produces two kinds of GIF, both additive — the PNGs and the WebM are
always kept beside them:

| Artifact | What it is |
|---|---|
| `<viewport>-<theme>-scroll.gif` | one stepped capture packed into one file |
| `<viewport>-<theme>-<state>.gif` | one animation recording, packed from its WebM |

**Why they exist.** `read` renders images, GIFs and PDFs — it does **not**
render WebM. So a WebM cannot be reviewed by a model reviewer at all, and a
stepped route like `/how-it-works` on mobile costs eleven separate attachments
to review one page. That is what caused the 2026-09-29 review fan-out to come
back `Rate limit exceeded` with parts cancelled. One file is one attachment.

**Why they needed a module.** Playwright's ffmpeg is a screencast build — it
muxes `webm` and `image2` and has no GIF muxer at all. The audit used to ask it
for one anyway, behind a capability probe, and the probe was *permanently false*
on this machine: every animation silently produced no GIF, and no GIF is a
WebM, which is precisely the artifact nobody can review. The pipeline is now
ffmpeg to **decode** (it decodes vp8 fine) plus Pillow to **encode**, with the
run reporting which half is missing rather than omitting the artifact:

```
[audit] gif              available (Pillow 12.3.0) — one GIF per animation and per stepped sequence
```

Pillow lives in the **system** python, not the backend venv, which is why every
entry point degrades instead of throwing: a run must not die over a derived
convenience artifact. A missing half costs the GIF, and the PNGs stand.

Defaults were measured on a real 5.04s / 25fps / 1440x900 recording, not guessed:
16 frames at 640px is ~1.2s to encode. A 640px GIF is a **motion summary** — it
is not where fine text is read, which is exactly why the full-resolution PNGs
are kept rather than replaced.

**One palette per visual state, and why that is the only policy that works.** A
256-colour GIF is lossy, so *which* colours it loses is a decision, and all three
obvious decisions were rendered and looked at rather than reasoned about. Against
the live render, worst stat-tile fill error on frames of the *same settled page*:

| Policy | Worst dE | What it does to a reviewer |
|---|---|---|
| Palette per frame (64) | 100 | tile hue swings ~40° between identical frames — reads as the UI changing colour |
| One palette per clip (64) | 100 | vivid blue `(37,99,235)` renders as steel `(55,87,167)` |
| One palette per clip (256) | 111 | vivid blue renders as grey slate `(103,119,148)` |
| **Palette per visual state (256)** | **6.7** | correct |

Per-frame has room for the page's saturated colours but lets a constant colour
render differently per frame — the one false finding a motion artifact must never
manufacture. One palette for the clip is stable and *starved*: a recording holding
both a light and a dark page spends its 256 entries on the two backgrounds, and
median-cut allocates by area, so the accents never get in. Reserving entries for
"flat" colours does not rescue it either, because the WebM is lossy — a flat tile
arrives as ~1000 near-identical colours, so 1351 gradient candidates outrank the
accents by area.

So the palette belongs to a *visual state*: consecutive frames showing the same
thing share one palette (compared on an 8×8 luminance signature), and each state
spends the whole budget on the colours that state actually contains. Dithering is
on; without it the dark hero broke into hard staircase patches. The cost is size
— 955 KB against 497 KB for a 3.84s clip, because each state carries its own
table. Verified by rendering: max dE 2.8 anywhere, tile hue span ≤1.5° within a
state, no visible seam where the palette changes at the crossfade.

Flags: `--base=`, `--out=`, `--only=`, `--keep-runs=`, `--budget-mb=`,
`--video-themes=light,dark`, `--gate[=signals]`, `--baseline=`,
`--pixel-baseline=DIR`, `--update-pixel-baseline`, `--pixel-tolerance=`,
`--changed-ratio=`, `--update-baseline`, `--headed`.

### Gating on regressions (`--gate`)

A plain run **always exits 0** — it reports, it does not judge. `--gate` is the
judging mode: it compares this run's signals against the committed
`scripts/audit-baseline.json` and exits 1 if it finds anything new.

```bash
docker compose exec dev node scripts/audit.mjs --gate                    # fail on a new regression
docker compose exec dev node scripts/audit.mjs --gate=contrast,overflow  # narrow the signals
docker compose exec dev node scripts/audit.mjs --update-baseline         # accept this run
```

```bash
make gate-ui   # a full gated pass — use this before pushing UI changes
```

How to read it:

- **Known findings pass.** A problem that is already in the baseline does not
  fail the run; that is what the baseline is for. `resolved` findings are
  reported too, so the file does not accumulate dead entries forever.
- **A missing baseline fails.** An unconfigured gate is not a passing gate, so
  a deleted or uncommitted baseline is an error with instructions, not a green
  run.
- **`--update-baseline` never fails.** It accepts whatever the run found and
  exits 0, which is why the baseline diff belongs in the PR: that review, not the
  command, is what makes accepting a finding safe.
- **It gates on signals, not pixels.** `contrast`, `page-errors`, `skips`,
  `overflow`, `unlabelled`, `rate-limited` (plus opt-in `landmarks`) are text
  and compare reliably anywhere. Console and network errors are report-only:
  third-party font CDNs are frequently unreachable from inside the container,
  so a failed asset request usually describes the environment, not the UI.
- **A 429 gates, under its own signal.** It is the one request failure that
  indicts the *tool* — the app treats a refused `/auth/me` as "no session" and
  a refused `/qa/models` as "no models", and both look exactly like a missing
  element (#535). The pacer keeps a **reserve of 12** requests in the tail of
  each 60 s window, so it stops before it can be refused rather than reacting
  after; a `rate-limited` finding means that reserve was not enough.
- **It cannot be combined with `--only`.** The baseline describes a full pass; a
  partial run would report every group it skipped as "resolved" and a reviewer
  could accept the truncated list by accident.
- **Keys identify the element, not the measurement.** Retuning a colour that is
  already failing does not read as a new regression — the same finding gets
  reported as "known but changed" instead, which is the signal that it got worse.

`gate-report.json` lands in the run directory with the new / known / changed /
resolved sets, so a CI job can annotate from JSON rather than scraping stdout.

### Pixel diffing (`--pixel-baseline`)

The gate above answers *"is this wrong"*. It cannot answer *"did this move"* — a
card that shifted 8px, a badge that vanished or a panel that stopped rendering
all pass every signal. `--pixel-baseline` compares this run's captures against a
baseline **directory** of PNGs.

```bash
# First time, or after an intentional visual change: make this run the reference
docker compose exec dev node scripts/audit.mjs --pixel-baseline=/tmp/opencode/pb --update-pixel-baseline

# Compare a run against it
docker compose exec dev node scripts/audit.mjs --pixel-baseline=/tmp/opencode/pb
```

Names are `--pixel-*` on purpose: `--baseline` and `--update-baseline` already
mean the *signal* baseline (a JSON file), and one tool meaning "baseline" for
both a JSON file and a directory of PNGs is a trap.

- **The baseline is local and is never committed.** A full pass is 174 PNGs /
  26 MB of images, and they are only meaningful on the machine that captured
  them. `--update-pixel-baseline` refuses to run without an explicit
  `--pixel-baseline=DIR` so it cannot drop 26 MB into a diff.
- **It is not a CI gate, and never exits 1.** A baseline is only comparable
  against its own CPU, Chromium build and font rasterisation; elsewhere every
  edge is a difference. A mismatch is a reason to look, not a red X. CI uses the
  signal gate, which is the environment-independent half.
- **Captures match by run-relative path** (`<route>/<viewport>-<theme>-<state>.png`),
  so a run directory *is* a valid baseline.
- **Added and removed captures are first-class.** A capture that stopped being
  produced is not a non-event — a capture count would hide it, because a dropped
  state is offset by a new one appearing elsewhere.
- **A resize is reported separately**, not scored as pixels, since a broken
  responsive layout outranks a colour shift and has no meaningful pixel count.
- **Two thresholds**, both recorded in `pixel-diff.json`: `--pixel-tolerance`
  (per-pixel, default 0.1) ignores antialiasing; `--changed-ratio`
  (per-capture, default 0.001) decides what counts as changed.
- **Diff images are reviewable**: changed pixels at full strength over a dimmed
  greyscale original, written to the run's `diff/`. A raw diff mask tells you
  *that* something moved, not *what*.

#### Capture determinism

Pixel diffing is only as good as the captures, and the first comparison run
immediately found the audit disagreeing with itself: **8 of 28 landing captures
differed between two runs of identical code, up to 17.8% of a capture's
pixels.** Two causes, both fixed:

- **Infinite CSS animations.** The pages carry at least nine (`logo-scroll` 42s,
  `mesh-drift` 16s, `auth-bg-shift` 18s, `preview-float` 9s, …) and none respect
  `prefers-reduced-motion`, so the logo marquee's position at capture time was
  arbitrary. Captures now pass `animations: "disabled"`, which fast-forwards
  animations to their end state. App behaviour is untouched. → 8 → 4 unstable.
- **Scroll-triggered reveals.** After a scroll, a `.reveal` element may be
  mid-transition or not yet triggered, and in one run's capture a whole pricing
  block was present while in the next it was still at `opacity: 0` — 39% of the
  image. The audit now waits for every reveal the observer *would* have fired
  for, mirroring `useScrollReveal` (threshold 0.15, `rootMargin … -10%`) rather
  than guessing "is it on screen". Guessing strictly is worse than useless: the
  pricing table is 837px tall, so "any part visible" is true when 150px peeks in
  and the wait would demand a reveal that never comes.

Two scenarios are still flaky and are tracked separately (#474):

- **`carousel-hover`** — the product carousel auto-advances on a JS timer, which
  `animations: "disabled"` cannot reach. Measured 3 distinct image states across
  3 identical runs.
- **`pricing-annual`** — the billing-toggle click occasionally lands in the other
  state (measured 2 states across 3 runs for one theme; other themes stable).

Stable captures, for contrast: `landing-*-hero` and
`desktop-light-pricing-annual` hashed identically across 3 consecutive runs.

#### Stills are captured with reduced motion (#485)

`animations: "disabled"` cancels an infinite animation to its *initial* state,
but the compositor still rasterises that cancelled state at a sub-pixel offset
that depends on frame timing. That left `carousel-hover` (all four viewport/theme
combinations) and `desktop-light-hero` varying by up to 0.55% of pixels between
identical runs, with a byte-identical DOM — noise sitting right at the edge of
the diff threshold, so a real regression there would have been unrecognisable.

Forcing the media feature is stronger than cancelling animations, so the stills
context sets `reducedMotion: "reduce"`. The stylesheet's own
`@media (prefers-reduced-motion: reduce)` rules apply: decorative drifts stop at
their resting transform, and JS that checks `matchMedia` (`CountUp`,
`ScreenshotCarousel`) takes its reduced-motion branch too. The page is
photographed in its settled state, which is both the correct thing to capture and
a deterministic one.

**The video context deliberately does not set it.** Recording motion is that
path's whole purpose, and reduced motion would leave eight WebM clips of a
still page. Animation is verified by the videos instead.

**The trade-off, and what covers it.** With stills captured under reduced motion,
the audit can no longer see the animated state — so deleting an
`@media (prefers-reduced-motion: reduce)` block would leave every diff green.
`frontend/src/reducedMotion.test.ts` pins that instead, asserting the decorative
selectors keep their opt-out. Read the two together: the audit proves the page
is right when still, the test proves it still honours the preference.

Four behaviours worth knowing before you trust a run:

- **Presence is asserted before every capture, and the route is asserted after
  every navigation.** A rate-limited `/app/*` load lands on `/login`, which
  renders perfectly; a presence check on `main` alone would photograph the
  login page and file it as a successful capture of the dashboard.
- **Requests are paced off `X-RateLimit-Remaining`, with a reserve.** A full
  pass makes far more than the 100 requests/minute the limiter allows. The
  pacer stops while 12 requests of each window are still in hand and sleeps out
  the rest, so it never spends the window to zero; the previous design reacted
  at zero, by which time the request that noticed had already been refused
  (#535). A pass therefore reports zero 429s, and any that appear surface as a
  `rate-limited` gate finding.
- **Animations are WebM, not GIF.** The container's ffmpeg is Playwright's
  screencast build (webm/image2 muxers, libvpx only — no GIF muxer), so the run
  checks once and says so instead of failing a conversion per video.
- **The QA `answer` scenario needs a real provider, and is a SKIP without one.**
  `qa/answer` submits a question and waits up to 120 s for
  `.chat-message.assistant .copy-answer-btn`. That is the *only* selector that
  means "a finished answer": the loading placeholder is
  `<div class="chat-message assistant"><div class="message-content">` —
  byte-identical to a real answer — so requiring `.message-content` matches the
  "Thinking…" spinner, and the gate passes on a photograph of a pending request.
  A sandbox with no `GROQ_API_KEY`, no `OPENAI_API_KEY` and no
  `LOCAL_LLM_ENABLED` cannot answer, so the scenario records a skip — and
  **`skips` is a gate signal**, so `--gate` fails. That is deliberate: a run that
  quietly dropped the one capture of the app's primary render would report
  "0 skipped" and read as full coverage. Configure a provider before running a
  gated pass; `--only=qa` is fine for a quick look, but it cannot be gated at all.
- **Small-target counts are split by WCAG 2.5.8's own excuses.** Inline prose
  links, checkboxes (the `<label>` is the target) and off-screen elements are
  counted separately, so the headline list is real leads rather than 200 links
  in a paragraph. Those two excuses are *heuristics*, though — an anchor inside
  a `<p>` that is really a button gets excused — so the raw count stays visible
  and the excuse travels with each item. It is a lead-list, not a verdict, and
  the gate does not act on it.

Known limitations are listed by `--help`: `/app/admin` is captured as the
access-denied branch because the fixture user is a customer and no public
endpoint can promote it. The QA `answer` state needs a configured provider — see
the behaviour list above. Thumbnails *do* load since #536 — the document bytes
are streamed by the API under a signed token instead of by the object store, so
there is no browser-facing storage address left to be wrong.

### Marketing pages are captured in steps (#552)

Every route in `GROUPS.public` is walked from the top down and captured one
viewport-sized screenful at a time — `top`, `page-2`, `page-3`, … — instead of one
image of the first fold.

That used to be a single `top` screenshot, which is 900px of a page running
several thousand. The audit reported `horizontalOverflow: []` and zero findings
for content it had never rendered, and three reviewers of the 2026-09-29 run said
so independently and unprompted: below-the-fold content was out of frame, and
`how-it-works` stages 2–6 appeared in **no image at all**.

**Why not `fullPage: true`,** which the legal group uses:

- `page.screenshot({ fullPage })` **does not scroll** — it resizes the capture
  surface. A reveal below the fold can still be at `opacity: 0` when the buffer is
  taken, which is exactly the blank-band failure the extra coverage is meant to
  catch.
- It produces one image 5–6× a viewport tall, which every viewer downscales until
  the detail that made it worth capturing is gone.

Stepping gets both right: every capture is a real scroll, so every reveal gets the
scroll it was waiting for, and each image is one readable screenful. Measured:
`/how-it-works` goes from 4 captures to 7 on desktop and from 4 to 11 on mobile.

**The legal group is deliberately not stepped.** Those pages are one long uniform
column of body text with no scroll-triggered reveals and no interactive states, so
`fullPage` is both correct and cheaper there — nothing is hiding below the fold.

Four things worth knowing:

- **Steps overlap by 120px** (`DEFAULT_STEP_OVERLAP_PX`). A step boundary lands
  wherever the arithmetic lands, and a section starting 40px above the cut is then
  split across two images with the seam invisible in either — so a broken heading
  gets read as fine twice. The overlap puts the seam inside the previous frame, so
  whatever is near it appears whole in at least one image.
- **The walk stops when the page says it is at the bottom**, not when the plan runs
  out. The page settles to a *shorter* height than it measured at while planning
  (fonts and images resolve after first paint), so the final planned offset can
  clamp onto the screenful before it. Measured on `/contact`: 2528px at plan time,
  2438px settled, last two offsets landing on the same pixel. Photographing that
  twice files two names for one image **and** fails the gate, because `skips` is a
  signal — a correct walk failing on a plan that was right for the page as first
  painted.
- **Reaching the bottom can cost a duplicate frame, and replacing instead can cost
  a *gap*.** These pull in opposite directions. When the remainder after the
  stride walk is small, appending a final step yields a frame 91% identical to the
  one before it (measured on `/how-it-works`: 81px of advance). Moving the last
  step forward instead is worse — 1200px of advance on a 900px viewport leaves the
  tail of the previous frame unphotographed, and a gap is invisible where a
  duplicate is merely wasteful. So replacement is only used when the remainder
  fits inside the overlap that was already going to be re-shot.
- **A page taller than `MAX_PAGE_STEPS` is reported, not silently trimmed.** The
  bottom of such a page is not covered, and a run that reported the partial walk
  as a success would be worse than one that says so.

`planPageSteps` is pure and lives in `scripts/audit-interactions.mjs`, so the
arithmetic is unit-tested across a range of heights without a browser. `stepMoved`
is the runtime duplicate check.

A full pass currently takes about 13 minutes, of which 2–4 are spent holding the
rate-limit reserve back. Individual groups take 1–2 minutes.

## Validating infra locally

`infra.yml` runs on a `ci`-labelled `dev`→`main` PR or a manual dispatch — **not
on a push to `dev`** (see *CI triggers* in `AGENTS.md`). So a change to
`infra/**` gets no `kustomize build`, `helm lint` or `kubeconform` anywhere on
its way to `dev`, and a manifest typo is discovered by the release PR. Run the
same validation before opening the PR.

The tools are not project dependencies. `mise.toml` pins `kustomize` and `helm`,
but **not** `kubeconform`, so it needs a separate install:

```bash
mise install                                    # kustomize + helm
#   kubeconform v0.6.7 (no mise entry):
#     brew install yannh/kubeconform/kubeconform
#   or: curl -sSL https://github.com/yannh/kubeconform/releases/download/v0.6.7/kubeconform-linux-amd64.tar.gz | tar -xz -C /usr/local/bin

kustomize build infra/k8s/overlays/dev       > /tmp/dev-rendered.yaml
kustomize build infra/k8s/overlays/staging   > /tmp/staging-rendered.yaml
kustomize build infra/k8s/overlays/production > /tmp/prod-rendered.yaml
helm lint infra/helm/ai-platform
helm template ai-platform infra/helm/ai-platform > /tmp/helm-rendered.yaml

for f in dev staging prod helm; do
  kubeconform -strict -ignore-missing-schemas -summary /tmp/$f-rendered.yaml
done
for manifest in infra/argo/*.yaml; do
  kubeconform -strict -ignore-missing-schemas -summary "$manifest"
done
```

`-ignore-missing-schemas` is what makes the CRD-carrying resources (cert-manager,
External Secrets, Prometheus, ArgoCD) report as *Skipped* instead of failing; a
non-zero `Invalid` or `Errors` is a real failure.

CI pins kustomize v5.5.0 and helm v3.16.4, while `mise.toml` tracks `latest` for
both — so a local pass is a good signal, not a guarantee. A render difference
between your machine and CI is usually a tool version, and a genuine schema
failure reproduces on both.

Images are built by `infra/scripts/build-images.sh [registry] [tag]`, which
reuses the `./backend` source tree as the worker image's build context. That one
only needs Docker:

```bash
./infra/scripts/build-images.sh            # ai-platform/*:latest, no registry
```

**Why this is a manual step rather than a push trigger.** Splitting the concern
is the point: validation is cheap and should cover every change, while
publishing to ghcr.io on every `dev` push is neither wanted nor free. Bundling
them meant the only automated check for a dev merge was a *publish*, so a
manifest error surfaced at release time and the newest green checks on `dev` all
predate the current trigger config.

### Running the workflow itself (including from a feature branch)

`workflow_dispatch` is the other escape hatch, and it runs against whichever **ref you
pick** in the dropdown. The two publishing jobs are ref-restricted, so what a dispatch
does depends on the ref:

| Dispatch ref | `validate` | `build-images` + `scan-images` | `smoke` |
|---|---|---|---|
| `main` | runs | **publishes** | runs |
| a feature branch | runs | **refused (skipped)** | runs |
| a tag | runs | **refused (skipped)** | runs |

```bash
# Any ref is safe now. A feature branch gets the real checks in CI:
gh workflow run infra.yml --ref feat/544-guard-latest-publish-on-dispatch
gh run watch --exit-status      # then: gh run list --workflow=infra.yml --limit 1

# From main, publishing happens as well:
gh workflow run infra.yml --ref main
```

**Why the restriction exists.** `build-images` tags whatever it pushes as both a SHA tag
and the floating `latest`, and the staging and production overlays are `latest`-pinned
with ArgoCD self-heal watching them — so moving `latest` *is* a production action. The
guard used to be `github.event_name == 'workflow_dispatch' || ...`, which admits a
dispatch of **any** ref, so `gh workflow run infra.yml --ref <feature-branch>` published
unmerged code as `latest` and rolled both environments onto it. The safe action and the
dangerous one were the same command (#544).

The condition is now:

```yaml
if: >-
  (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
  (github.event_name == 'pull_request' && contains(...labels, 'ci') && ...)
```

`validate` and `smoke` are deliberately left runnable from any ref: they never write to
the registry and never resolve `latest`, so they are exactly what a feature branch wants.
`packages: write` is likewise scoped to the single pushing job rather than the whole
workflow, so a read-only job cannot write to the registry even if its condition is later
widened by mistake. Both properties are pinned by
`backend/tests/test_infra_workflow_publish_guard.py`, which *evaluates* the conditions
over a table of event contexts rather than string-matching them.

A second, milder surprise: the validation steps are gated on
`steps.changes.outputs.infra == 'true'` from `dorny/paths-filter`, which
resolves a `workflow_dispatch` ref against a base rather than the PR diff. A
dispatch of a branch whose changes do not touch `infra/**` can therefore skip the
validation body entirely. If a run reports skipped validation, the "Detect infra
changes" step log says which filter missed.

## Tools

```bash
make setup        # host deps: uv sync + npm install (first clone)
make host-tools   # mise install — kind/kubectl/helm/kustomize/devspace (host)
```

## Migrations

- Sandbox: `alembic upgrade head` runs automatically on `make dev-up`.
- Host-native: `cd backend && uv run alembic upgrade head`.
- New migrations: `cd backend && uv run alembic revision --autogenerate -m "..."`.

## Re-embedding chunks left unsearchable by migration 008

Migration 008 added `embedding_model` and left pre-existing rows NULL rather than
guess which model wrote their vector — so those chunks are keyword-searchable
only. If semantic search returns nothing from a database created before 008, this
is why. Check the state first; the command reports a plan and writes nothing
unless you pass `--apply`:

```bash
cd backend
uv run python scripts/backfill_embeddings.py                    # dry run: the plan, no writes
uv run python scripts/backfill_embeddings.py --limit 50 --apply  # write at most 50 chunks
uv run python scripts/backfill_embeddings.py --apply            # write everything waiting
```

`--limit` bounds a **write** run. In a dry run it is reported but the plan still
counts the whole corpus, so it is not a way to preview a subset.

It recomputes each vector from the chunk's `content` rather than relabelling the
existing one, so it cannot attribute a vector to a model that did not write it.
It fills **one** space per run (whichever is active — a config change plus a
second run covers the other), and a re-run is a no-op rather than a relabel, so
it is safe to repeat. Skipped rows are reported and stay unsearchable by vector:
re-upload or re-process those documents.
