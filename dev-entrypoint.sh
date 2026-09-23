#!/bin/bash
set -euo pipefail

# Dev-sandbox entrypoint — runs uvicorn (backend) + vite (frontend) in the
# foreground on the dev compose service, forwarding SIGTERM/SIGINT so
# `docker compose stop`/Ctrl-C shuts both down cleanly.
#
# Interactive shell inside the sandbox:
#   docker compose run --rm --entrypoint bash dev
#
# Backend deps are baked at image build into /opt/backend-venv (outside the
# bind mount); the script re-syncs only when the baked venv is missing (e.g.
# a pyproject change that predates an image rebuild — prefer `make dev-build`).
# Frontend deps are shared with the host in the workspace; npm ci runs only
# when missing.

BACKEND_DIR=/workspace/backend
FRONTEND_DIR=/workspace/frontend
BACKEND_VENV="${UV_PROJECT_ENVIRONMENT:-/opt/backend-venv}"

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