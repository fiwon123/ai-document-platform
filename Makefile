.PHONY: help setup host-tools infra-up infra-down preflight dev-up dev-build dev-down dev-restart \
        dev-log dev-exec dev-agent opencode sandbox reset \
        test test-backend test-frontend lint lint-fix format typecheck build check

COMPOSE := docker compose
BACKEND_DIR := backend
FRONTEND_DIR := frontend

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
# host opencode binary + config, git identity, gh auth, and the Docker socket
# read-only (see DEVELOPMENT.md). Only the sandbox-starting targets below
# require the host opencode binary; the host-native loop (infra-up, make check)
# never does.
# NOTE: not named OPENCODE — the opencode agent runtime exports an OPENCODE
# env var (=1) which would override a ?= default via make's env import.
OPENCODE_BIN ?= $(HOME)/.opencode/bin/opencode

preflight: ## (internal) Require host opencode + pre-create mounted config paths
	@test -x "$(OPENCODE_BIN)" || { echo "ERROR: opencode not found at $(OPENCODE_BIN)" >&2; \
	  echo "  Install: curl -fsSL https://opencode.ai/install | bash" >&2; exit 1; }
	@mkdir -p "$(HOME)/.config/opencode" && touch "$(HOME)/.gitconfig"

dev-up: preflight ## Start the isolated dev sandbox (uvicorn + vite + worker + infra)
	$(COMPOSE) up dev

dev-build: ## Rebuild the dev image after Dockerfile/pyproject/uv.lock changes
	$(COMPOSE) build dev

dev-down: ## Stop the dev sandbox (keeps volumes)
	$(COMPOSE) down

dev-restart: preflight ## Stop and restart the dev sandbox in one step (volumes kept)
	$(COMPOSE) down
	$(COMPOSE) up dev

dev-log: ## Tail dev sandbox logs
	$(COMPOSE) logs -f dev

dev-exec: ## Open a shell inside the dev sandbox
	$(COMPOSE) exec dev bash

opencode: preflight ## Run the AI coding agent (opencode) inside the dev sandbox
	$(COMPOSE) ps -q dev >/dev/null 2>&1 || $(COMPOSE) up -d dev
	$(COMPOSE) exec -it dev bash -lc "cd /workspace && opencode"

# Alias kept for compatibility with earlier dev-sandbox docs.
dev-agent: opencode

sandbox: preflight ## Open an interactive shell in the dev sandbox (opencode ready)
	scripts/open-in-sandbox.sh

reset: ## Stop everything and wipe volumes (clean slate)
	$(COMPOSE) down -v

# --- Testing ----------------------------------------------------------------
test: test-backend test-frontend ## Run all tests

test-backend: ## Run backend tests (pytest)
	cd $(BACKEND_DIR) && uv run pytest

test-frontend: ## Run frontend tests (vitest)
	cd $(FRONTEND_DIR) && npm test

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