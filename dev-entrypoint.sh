#!/bin/bash
# CRLF guard (#762) — deliberately the first executable statement, above
# `set -euo pipefail`. There is no blank line between here and the guard on
# purpose: an empty line in a CRLF copy is a bare `\r` command, and bash would
# report `$'\r': command not found` before the guard could say anything useful.
# Comment lines absorb it; use `#` on its own for a paragraph break, never an
# empty line.
#
# This script runs through bash from the bind mount, so bash parses the *host*
# working-tree bytes. A Windows checkout whose working tree predates the
# `.gitattributes` `* text=auto eol=lf` rule keeps stale CRLF bytes, and
# `git status` stays clean throughout, because git compares normalized content.
# Bash then reads `set -euo pipefail\r` and dies with `set: pipefail: invalid
# option name` — a message that names neither the cause nor a repair.
#
# The guard has to survive the CRLF it reports. Bash parses a whole compound
# command before executing it, so a plain multi-line `if` would fail to parse
# before its own check ever ran. Every line of this block therefore ends with
# the `# crlf-guard` tag: that is where the trailing `\r` lands, inside a
# comment, where it does no harm. The tag also delimits the block for the test
# that pins this behaviour (backend/tests/test_dev_entrypoint_crlf_guard.py).
#
# The `-f` test covers the one invocation this cannot check: piped in
# (`bash < dev-entrypoint.sh`), where BASH_SOURCE is empty and grep would report
# `grep: : No such file or directory` before skipping. Compose always passes a
# path, so this is about staying quiet where the check is impossible, not about
# covering that case.
#
# The message points at the remedy README.md already documents under
# Troubleshooting rather than inventing a second, narrower one: this failure
# means the *whole* working tree is stale, not just this file.
if [[ -f "${BASH_SOURCE[0]}" ]] && grep -q $'\r$' "${BASH_SOURCE[0]}"; then # crlf-guard
    printf '%s\n' "[dev] ${BASH_SOURCE[0]##*/} has CRLF line endings, so bash cannot parse it — the sandbox would die with 'set: pipefail: invalid option name' (#762)." "      The bind mount serves the host checkout as-is. Re-check it out with LF endings (README.md → Troubleshooting):" >&2 # crlf-guard
    printf '%s\n' "        git rm --cached -r . >/dev/null && git reset --hard" >&2; exit 1 # crlf-guard
fi # crlf-guard

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