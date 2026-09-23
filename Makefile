.PHONY: help setup host-tools infra-up infra-down dev-up dev-build dev-down dev-log dev-exec reset \
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
dev-up: ## Start the isolated dev sandbox (uvicorn + vite + worker + infra)
	$(COMPOSE) up dev

dev-build: ## Rebuild the dev image after Dockerfile/pyproject/uv.lock changes
	$(COMPOSE) build dev

dev-down: ## Stop the dev sandbox (keeps volumes)
	$(COMPOSE) down

dev-log: ## Tail dev sandbox logs
	$(COMPOSE) logs -f dev

dev-exec: ## Open a shell inside the dev sandbox
	$(COMPOSE) exec dev bash

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