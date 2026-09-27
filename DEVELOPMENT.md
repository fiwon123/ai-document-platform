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
QA_MODEL=llama-3.3-70b-versatile         # optional: pin the default model
```

Then `make dev-restart` (variables are read at process start, so a running
container keeps the old environment). Confirm with `GET /v1/qa/models`, where
each model reports `available`.

Three things worth knowing:

- **A local model server needs an opt-in *and* a reachable host.** Ollama on the
  host is not at `localhost` from inside the container:

  ```bash
  LOCAL_LLM_ENABLED=true
  LOCAL_LLM_BASE_URL=http://host.docker.internal:11434/v1
  LOCAL_LLM_MODEL=llama3.2:1b
  ```

  Use the container's name instead of `host.docker.internal` if the server is
  another Compose service.
- **`OPENAI_BASE_URL` redirects embeddings *and* the OpenAI QA provider.** It is
  the OpenAI SDK's own environment default, not a project feature, which is why
  `embedding.py` never mentions it — it also happens to be the cleanest way to
  point both at a local OpenAI-compatible server or a test stub.
- **Unset means the app's own default, not empty.** Each variable's Compose
  default mirrors the `os.getenv` fallback in the code, because
  `load_dotenv()` does not override real environment variables — an empty value
  passed from Compose would win over `backend/src/app/.env` and over the code's
  fallback. `tests/test_compose_env.py` pins the two lists together.

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

It registers its own throwaway user, seeds four documents (ready, ready, ready,
and a deliberately corrupt PDF so the failure card is real), waits for the
worker, then walks the route groups. Output lands in
`/tmp/opencode/visual-audit/<timestamp>/` with a `summary.json` and an
`audit-manifest.json` that has one entry per capture. Copy the run out to look
at it:

```bash
docker compose cp dev:/tmp/opencode/visual-audit/<timestamp> ./audit-run
```

Budget and retention: 500 MB per run (a hard stop, with GIF conversion checked
before it can overshoot), the newest 2 runs kept, and Playwright's raw
`.video-tmp` scratch directory removed at the end. Manifest and summary bytes
count against the budget too, since they are what a reviewer opens first — and
the figure inside `summary.json` is rewritten to include them, so the number in
the file matches the number in the console.

Flags: `--base=`, `--out=`, `--only=`, `--keep-runs=`, `--budget-mb=`,
`--video-themes=light,dark`, `--gate[=signals]`, `--baseline=`,
`--update-baseline`, `--headed`.

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
  `overflow`, `unlabelled` (plus opt-in `landmarks`) are text and compare
  reliably anywhere. Console and network errors are report-only, because
  MinIO's presigned URLs make them permanently noisy from inside the container.
- **It cannot be combined with `--only`.** The baseline describes a full pass; a
  partial run would report every group it skipped as "resolved" and a reviewer
  could accept the truncated list by accident.
- **Keys identify the element, not the measurement.** Retuning a colour that is
  already failing does not read as a new regression — the same finding gets
  reported as "known but changed" instead, which is the signal that it got worse.

`gate-report.json` lands in the run directory with the new / known / changed /
resolved sets, so a CI job can annotate from JSON rather than scraping stdout.

Four behaviours worth knowing before you trust a run:

- **Presence is asserted before every capture, and the route is asserted after
  every navigation.** A rate-limited `/app/*` load lands on `/login`, which
  renders perfectly; a presence check on `main` alone would photograph the
  login page and file it as a successful capture of the dashboard.
- **Requests are paced off `X-RateLimit-Remaining`.** A full pass makes far
  more than the 100 requests/minute the limiter allows, so the run sleeps out
  the window instead of bouncing off 429s.
- **Animations are WebM, not GIF.** The container's ffmpeg is Playwright's
  screencast build (webm/image2 muxers, libvpx only — no GIF muxer), so the run
  checks once and says so instead of failing a conversion per video.
- **Small-target counts are split by WCAG 2.5.8's own excuses.** Inline prose
  links, checkboxes (the `<label>` is the target) and off-screen elements are
  counted separately, so the headline list is real leads rather than 200 links
  in a paragraph. Those two excuses are *heuristics*, though — an anchor inside
  a `<p>` that is really a button gets excused — so the raw count stays visible
  and the excuse travels with each item. It is a lead-list, not a verdict, and
  the gate does not act on it.

Known limitations are listed by `--help`: thumbnails and download links do not
load in these captures (presigned URLs are signed for `localhost:9000`, which
the in-container browser cannot reach — correct for a browser on the host), and
`/app/admin` is captured as the access-denied branch because the fixture user is
a customer and no public endpoint can promote it.

A full pass currently takes about 11 minutes, of which roughly 5 are spent
sleeping out the rate limiter. Individual groups take 1–2 minutes.

## Tools

```bash
make setup        # host deps: uv sync + npm install (first clone)
make host-tools   # mise install — kind/kubectl/helm/kustomize/devspace (host)
```

## Migrations

- Sandbox: `alembic upgrade head` runs automatically on `make dev-up`.
- Host-native: `cd backend && uv run alembic upgrade head`.
- New migrations: `cd backend && uv run alembic revision --autogenerate -m "..."`.