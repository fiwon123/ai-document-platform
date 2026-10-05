#!/bin/bash
set -euo pipefail

# Dev-sandbox entrypoint — runs uvicorn (backend) + vite (frontend) in the
# foreground on the dev compose service, forwarding SIGTERM/SIGINT so
# `docker compose stop`/Ctrl-C shuts both down cleanly.
#
# Interactive shell inside the sandbox:
#   docker compose run --rm --entrypoint zsh dev
#
# Backend deps are baked at image build into /opt/backend-venv (outside the
# bind mount); the script re-syncs only when the baked venv is incomplete (e.g.
# a pyproject change that predates an image rebuild — prefer `make dev-build`).
# Frontend deps are shared with the host in the workspace; npm ci runs only
# when missing.

PROJECT_DIR=/sandbox/ai-document-platform
BACKEND_DIR=$PROJECT_DIR/backend
FRONTEND_DIR=$PROJECT_DIR/frontend
BACKEND_VENV="${UV_PROJECT_ENVIRONMENT:-/opt/backend-venv}"

# Refuse to run as root. Compose and the image both select appuser; failing
# loudly here prevents a bypassed or stale configuration from recreating the
# root-owned bind-mount files this setup is designed to prevent.
if [[ "$(id -u)" == 0 ]]; then
    echo "[dev] Refusing to start as root; rebuild with make dev-build (issue #365)." >&2
    exit 1
fi

if [[ ! -d "$HOME" || ! -w "$HOME" ]]; then
    echo "[dev] Sandbox home '$HOME' is not writable as uid $(id -u); rebuild with make dev-build." >&2
    exit 1
fi

if [[ ! -d "$BACKEND_VENV" || ! -w "$BACKEND_VENV" ]]; then
    echo "[dev] Backend environment '$BACKEND_VENV' is not writable as uid $(id -u); rebuild with make dev-build." >&2
    exit 1
fi

# Fail early with an actionable message when an old root-created workspace is
# still mounted. New files then inherit the host identity, never root.
if ! write_probe="$(mktemp "$PROJECT_DIR/.dev-sandbox-write-probe.XXXXXX")"; then
    echo "[dev] Workspace '$PROJECT_DIR' is not writable as uid $(id -u):$(id -g)." >&2
    echo "      On the host, run: sudo chown -R \"\$(id -u):\$(id -g)\" ." >&2
    exit 1
fi
rm -f "$write_probe"

# --- Bootstrap dependencies if missing (first run on a fresh workspace) ---
if [[ ! -x "$BACKEND_VENV/bin/uvicorn" ]]; then
    echo "[dev] Backend dependencies missing — running 'uv sync' into $BACKEND_VENV ..."
    (cd "$BACKEND_DIR" && uv sync --frozen)
fi

if [[ ! -x "$FRONTEND_DIR/node_modules/.bin/vite" ]]; then
    echo "[dev] Frontend dependencies missing — running 'npm ci' ..."
    (cd "$FRONTEND_DIR" && npm ci)
fi

# --- Apply database migrations before uvicorn starts ---
echo "[dev] Applying database migrations (alembic upgrade head) ..."
(cd "$BACKEND_DIR" && "$BACKEND_VENV/bin/alembic" upgrade head)

# --- Start both dev servers ---
echo "[dev] Starting backend on http://localhost:8000 ..."
(cd "$BACKEND_DIR" && exec "$BACKEND_VENV/bin/uvicorn" app.main:app --reload --host 0.0.0.0 --port 8000) &

echo "[dev] Starting frontend on http://localhost:5173 ..."
(cd "$FRONTEND_DIR" && exec npm run dev -- --host 0.0.0.0 --port 5173) &

# Forward termination signals to the children (docker stop sends SIGTERM).
trap 'kill $(jobs -p) 2>/dev/null || true; exit 0' TERM INT

# Wait for the first server to exit, then stop the other and propagate.
wait -n
status=$?
kill $(jobs -p) 2>/dev/null || true
wait 2>/dev/null || true
exit $status