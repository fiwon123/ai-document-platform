#!/bin/bash
set -euo pipefail

# open-in-sandbox.sh — interactive shell inside the dev sandbox with the
# sandboxed AI coding agent (opencode) available.
#
# Ensures the stack is running, then opens bash in the `dev` container.
# opencode is injected via read-only compose mounts (see docker-compose.yaml):
#   - binary: ${HOME}/.opencode/bin/opencode          → /usr/local/bin/opencode
#   - config: ${HOME}/.config/opencode                → /root/.config/opencode
#   - git identity: ${HOME}/.gitconfig                 → /root/.gitconfig
#   - gh auth: ${HOME}/.config/gh                      → /root/.config/gh
#   - Docker socket: /var/run/docker.sock              → /var/run/docker.sock
#     (docker CLI + compose plugin are baked into the image; see Dockerfile)
#
# Trusted-agent model: the dev container shares the workspace (bind mount) and
# the Docker socket with the host BY DESIGN — isolation covers the agent's
# runtime, not Docker/workspace access. `make dev-up` pre-creates config paths.
#
# Usage:
#   scripts/open-in-sandbox.sh                  # interactive bash (opencode ready)
#   scripts/open-in-sandbox.sh 'uv run pytest'  # run one command in the sandbox

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Ensure the stack is running (idempotent; keeps postgres_data volume).
# NOTE: `docker compose ps -q` prints nothing (exit 0) for a defined-but-stopped
# service, so check the output, not the exit code.
if [ -z "$(docker compose ps -q dev)" ]; then
    echo "[sandbox] Starting dev stack (docker compose up -d dev)..."
    docker compose up -d dev
else
    echo "[sandbox] Dev stack already running."
fi

# One-shot command mode: use a TTY when we are interactive so tools like
# pytest --pdb keep working, and -T when stdin is piped.
if [[ $# -gt 0 ]]; then
    if [[ -t 0 ]]; then
        exec docker compose exec -it dev zsh -lc "$*"
    else
        exec docker compose exec -T dev zsh -lc "$*"
    fi
fi

echo "[sandbox] Dev sandbox shell — run the AI coding agent with:"
echo "          cd /workspace && opencode"
if [[ -t 0 ]]; then
    exec docker compose exec -it dev zsh
else
    exec docker compose exec -T dev zsh
fi