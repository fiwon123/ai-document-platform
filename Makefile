.PHONY: help setup host-tools infra-up infra-down check-identity check-gh-token preflight dev-up dev-build dev-down dev-restart \
        dev-log dev-exec dev-agent opencode shell sandbox reset \
        test test-backend test-frontend lint lint-fix format typecheck build check

COMPOSE := docker compose

# Run bind-mounted dev services as the host developer instead of root. Derive
# the identity from the workspace owner (not the current process) so invoking
# Make inside an already-running bind-mounted container still uses the host
# identity. The id fallback is only for unusual filesystems without stat.
HOST_UID ?= $(shell stat -c '%u' . 2>/dev/null || stat -f '%u' . 2>/dev/null || id -u)
HOST_GID ?= $(shell stat -c '%g' . 2>/dev/null || stat -f '%g' . 2>/dev/null || id -g)
HOST_HOME ?= $(HOME)
HOST_PROJECT_DIR ?= $(abspath .)
DOCKER_GID ?= $(shell stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || printf '999')
export HOST_UID HOST_GID HOST_HOME HOST_PROJECT_DIR DOCKER_GID

check-identity:
	@test "$(HOST_UID)" != "0" || { echo "ERROR: refusing to run the dev sandbox as UID 0; repair workspace ownership or set HOST_UID to the host user." >&2; exit 1; }

BACKEND_DIR := backend
FRONTEND_DIR := frontend

# Bring the dev sandbox up for the exec-style targets (dev-exec, opencode,
# shell). Deliberately NOT `$(COMPOSE) up -d --build`: the helper only builds
# when the stack was never initialized, and otherwise just reconciles containers
# and waits for readiness. That keeps `make shell` / `make opencode` from
# kicking off a redundant image build — and racing the running stack — when
# called right after `make dev-up` / `make dev-restart`.
# Pass COMPOSE= to the helper so it uses the same command as the Makefile.
SANDBOX_UP := COMPOSE="$(COMPOSE)" scripts/ensure-sandbox-running.sh

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# --- Host-native path (fastest, no containers) ----------------------------
setup: ## Install host-native deps (uv sync + npm install)
	cd $(BACKEND_DIR) && uv sync
	cd $(FRONTEND_DIR) && npm install

host-tools: ## Install dev tools on the host via mise (kind/kubectl/helm/...)
	mise install

# --- Infrastructure only (postgres/redis/minio) -----------------------------
infra-up: ## Start postgres/redis/minio only (for the host-native path)
	$(COMPOSE) up -d postgres redis minio

infra-down: ## Stop infra services
	$(COMPOSE) down postgres redis minio

# --- Isolated dev sandbox (dev + worker + infra) ----------------------------
# Sandboxed AI coding agent (trusted-agent model): the dev container mounts the
# host opencode binary + config, git identity, and gh auth read-only, plus the
# host Docker socket (RW by design — see DEVELOPMENT.md). Only the
# sandbox-starting targets below require the host opencode binary; the
# host-native loop (infra-up, make check) never does.
# NOTE: not named OPENCODE — the opencode agent runtime exports an OPENCODE
# env var (=1) which would override a ?= default via make's env import.
OPENCODE_BIN ?= $(HOME)/.opencode/bin/opencode

# Default for the sandbox: auto-approve permission prompts (trusted-agent
# model — the dev container already has the workspace + docker socket).
# Override per-invocation, e.g.:
#   make opencode OPENCODE_ARGS=""                      # bare TUI (prompts back)
#   make opencode OPENCODE_ARGS="--auto -m provider/model"
#   make opencode OPENCODE_ARGS="run 'task' --auto"     # one-shot non-interactive
OPENCODE_ARGS ?= --auto

# --- GitHub passthrough for the sandboxed agent --------------------------------
# The `dev` service forwards the host's GitHub token (see the GH_TOKEN entry in
# docker-compose.yaml) so the sandboxed agent can drive the issue → branch → PR
# workflow. The read-only ~/.config/gh mount cannot do that on its own: the host
# token normally lives in the OS keyring, so hosts.yml carries no
# `oauth_token` and the container — which has no keyring socket — ends up
# unauthenticated. The token therefore has to arrive as an env var, resolved from
# the host here at up-time.
#
# No global `GH_TOKEN` assignment on purpose. `export` alone keeps whatever the
# environment already provides (including the token this container was started
# with, so `make check` inside the sandbox keeps working), and the target-specific
# assignment below resolves a fresh credential for the targets that actually
# start the sandbox. A global `?=` would lose to an ambient GH_TOKEN that make
# imports as a variable — and a stale token in the shell silently shadows a
# working keyring login, which is the exact failure check-gh-token exists to
# catch. A command-line assignment still wins over both:
# `make dev-up GH_TOKEN=<pat>`.
export GH_TOKEN
dev-up dev-restart dev-exec opencode: GH_TOKEN = $(shell scripts/resolve-gh-token.sh 2>/dev/null)

# Refuse to start a sandbox whose gh is dead. A *rejected* token is fatal: it is
# worse than no token at all, because inside the container gh looks
# authenticated and then 401s on every call (and it breaks gh and git on the
# host, since git delegates to `gh auth git-credential`). An *absent* token or an
# unreachable GitHub is only a warning — the sandbox is still useful for local
# work, and being offline must never block `make dev-up`. Never prints the token.
check-gh-token:
	@scripts/resolve-gh-token.sh --check

preflight: check-identity check-gh-token ## (internal) Require host opencode + pre-create mounted config paths
	@test -x "$(HOST_HOME)/.opencode/bin/opencode" || { echo "ERROR: opencode not found at $(HOST_HOME)/.opencode/bin/opencode" >&2; \
	  echo "  Install: curl -fsSL https://opencode.ai/install | bash" >&2; exit 1; }
	@mkdir -p "$(HOST_HOME)/.config/opencode" "$(HOST_HOME)/.config/gh" && touch "$(HOST_HOME)/.gitconfig"

dev-up: preflight ## Start the isolated dev sandbox (uvicorn + vite + worker + infra)
	$(COMPOSE) up --build dev worker

dev-build: check-identity ## Rebuild the dev images after Dockerfile/pyproject/uv.lock changes
	$(COMPOSE) build dev worker

dev-down: ## Stop the dev sandbox (keeps volumes)
	$(COMPOSE) down

dev-restart: preflight ## Stop and restart the dev sandbox in one step (volumes kept)
	$(COMPOSE) down
	$(COMPOSE) up --build dev worker

dev-log: ## Tail dev sandbox logs
	$(COMPOSE) logs -f dev

dev-exec: preflight ## Open a shell inside the dev sandbox
	$(SANDBOX_UP)
	$(COMPOSE) exec dev zsh

opencode: preflight ## Run the AI coding agent (opencode) inside the dev sandbox
	$(SANDBOX_UP)
	@if [ -t 0 ]; then $(COMPOSE) exec -it dev zsh -lc "cd /sandbox/ai-document-platform && opencode $(OPENCODE_ARGS)"; else $(COMPOSE) exec -T dev zsh -lc "cd /sandbox/ai-document-platform && opencode $(OPENCODE_ARGS)"; fi

# Alias kept for compatibility with earlier dev-sandbox docs.
dev-agent: opencode

shell: preflight ## Open an interactive shell in the dev sandbox (opencode ready)
	scripts/open-in-sandbox.sh

# Alias kept for compatibility with earlier dev-sandbox docs.
sandbox: shell

reset: ## Stop everything and wipe volumes (clean slate)
	$(COMPOSE) down -v

# --- Testing ----------------------------------------------------------------
test: test-backend test-frontend ## Run all tests

test-backend: ## Run backend tests (pytest)
	cd $(BACKEND_DIR) && uv run pytest

test-frontend: ## Run frontend tests (vitest + audit baseline tests)
	cd $(FRONTEND_DIR) && npm test

# --- Visual audit -----------------------------------------------------------------
# A full gated pass takes ~11 minutes: it walks every route group x viewport x
# theme and paces itself off the app's rate limiter. It is deliberately not part
# of `make check` — that gate has to stay fast enough to run on every save.
gate-ui: ## Full visual audit, failing on any regression vs scripts/audit-baseline.json
	$(COMPOSE) exec dev node scripts/audit.mjs --gate

audit-baseline: ## Accept the last visual audit run as the new baseline
	$(COMPOSE) exec dev node scripts/audit.mjs --update-baseline

# --- Lint / format ------------------------------------------------------------
lint: ## Lint backend (ruff) + frontend (oxlint)
	cd $(BACKEND_DIR) && uv run ruff check src/
	cd $(FRONTEND_DIR) && npm run lint

lint-fix: ## Auto-fix lint issues
	cd $(BACKEND_DIR) && uv run ruff check --fix src/
	cd $(FRONTEND_DIR) && npm run lint:fix

format: ## Format backend code (ruff format)
	cd $(BACKEND_DIR) && uv run ruff format src/

# --- Build / typecheck ----------------------------------------------------------
typecheck: ## Frontend typecheck + build (tsc -b && vite build)
	cd $(FRONTEND_DIR) && npm run build

build: typecheck ## Build the frontend

check: lint test build ## Full local gate: lint + tests + build