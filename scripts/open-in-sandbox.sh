#!/bin/bash
set -euo pipefail

# open-in-sandbox.sh — interactive shell inside the dev sandbox with the
# sandboxed AI coding agent (opencode) available.
#
# Ensures the stack is running, then opens bash in the `dev` container.
# opencode is injected via read-only compose mounts (see docker-compose.yaml):
#   - binary: ${HOST_HOME}/.opencode/bin/opencode          → /usr/local/bin/opencode
#   - config: ${HOST_HOME}/.config/opencode                → /home/appuser/.config/opencode
#   - git identity: ${HOST_HOME}/.gitconfig                 → /home/appuser/.gitconfig
#   - gh auth: ${HOST_HOME}/.config/gh                      → /home/appuser/.config/gh
#   - GitHub token: forwarded as GH_TOKEN (see resolve-gh-token.sh below)
#   - Docker socket: /var/run/docker.sock              → /var/run/docker.sock
#     (docker CLI + compose plugin are baked into the image; see Dockerfile)
#
# Trusted-agent model: the dev container shares the workspace (bind mount) and
# the Docker socket with the host BY DESIGN — isolation covers the agent's
# runtime, not Docker/workspace access. `make dev-up` and this helper
# pre-create config paths.
#
# Usage:
#   scripts/open-in-sandbox.sh                  # interactive bash (opencode ready)
#   scripts/open-in-sandbox.sh 'uv run pytest'  # run one command in the sandbox

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Compose cannot evaluate `id` or inspect the host socket itself. Derive the
# identity from the workspace owner so this helper still works when called from
# an already-running bind-mounted container; Make exports the same values for
# its targets.
HOST_HOME="${HOST_HOME:-$HOME}"
HOST_PROJECT_DIR="${HOST_PROJECT_DIR:-$ROOT_DIR}"
workspace_uid="$(stat -c '%u' "$ROOT_DIR" 2>/dev/null || stat -f '%u' "$ROOT_DIR" 2>/dev/null || id -u)"
workspace_gid="$(stat -c '%g' "$ROOT_DIR" 2>/dev/null || stat -f '%g' "$ROOT_DIR" 2>/dev/null || id -g)"
export HOST_UID="${HOST_UID:-$workspace_uid}"
export HOST_GID="${HOST_GID:-$workspace_gid}"
export HOST_HOME HOST_PROJECT_DIR
if [ "$HOST_UID" = "0" ]; then
    echo "ERROR: refusing to run the dev sandbox as UID 0; repair workspace ownership or set HOST_UID to the host user." >&2
    exit 1
fi
if [ -z "${DOCKER_GID:-}" ]; then
    DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || printf '999')"
fi
export DOCKER_GID

# GitHub passthrough: the `dev` service forwards the host's GitHub token so the
# sandboxed agent can drive the issue → branch → PR workflow. The read-only
# ~/.config/gh mount cannot do that on its own — the host token normally lives in
# the OS keyring, so hosts.yml carries no `oauth_token` and the container (no
# keyring socket) ends up unauthenticated. Resolve and validate the credential
# here as well, since this script starts the stack directly rather than going
# through `make dev-up`. A rejected credential is fatal; an absent one only warns.
# The token is never printed.
"$SCRIPT_DIR/resolve-gh-token.sh" --check
sandbox_gh_token="$("$SCRIPT_DIR/resolve-gh-token.sh" 2>/dev/null || true)"
if [ -n "$sandbox_gh_token" ]; then
    export GH_TOKEN="$sandbox_gh_token"
fi

# Keep direct invocations equivalent to `make sandbox`: the read-only mounts
# must exist before Compose creates the container.
if [ ! -x "${HOST_HOME}/.opencode/bin/opencode" ]; then
    echo "ERROR: opencode not found at ${HOST_HOME}/.opencode/bin/opencode" >&2
    echo "  Install: curl -fsSL https://opencode.ai/install | bash" >&2
    exit 1
fi
mkdir -p "${HOST_HOME}/.config/opencode" "${HOST_HOME}/.config/gh"
touch "${HOST_HOME}/.gitconfig"

# Ensure the stack is running and the image matches this host identity.
# Compose's build cache keeps this inexpensive after the first run.
echo "[sandbox] Ensuring dev stack is built and running..."
docker compose up -d --build dev worker

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
echo "          cd /sandbox/ai-document-platform && opencode"
if [[ -t 0 ]]; then
    exec docker compose exec -it dev zsh
else
    exec docker compose exec -T dev zsh
fi