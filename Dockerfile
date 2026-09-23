# Dev image for the AI Document Platform (dev + worker compose services).
# Built by docker-compose.yaml (`context: .`, `dockerfile: Dockerfile`).
#
# This is the "dev sandbox": a slim, isolated runtime for the application.
# Source code is bind-mounted into /sandbox/ai-document-platform at runtime (hot reload);
# Python dependencies are baked into /opt/backend-venv at build time so the
# bind mount (which shadows /sandbox/ai-document-platform) cannot hide them. Frontend
# dependencies
# (node_modules) are relocatable and live in the workspace, shared with the
# host-native loop — dev-entrypoint.sh bootstraps them when missing.

# Pin the mise binary via the official image (ARG expands in FROM, which is
# the only context where it is supported — COPY --from cannot expand ARGs).
# Release tags have no `v` prefix (e.g. 2025.4.10).
ARG MISE_VERSION=2025.4.10
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise

# Static Docker CLI + compose plugin: lets the sandboxed AI coding agent
# (opencode INSIDE the dev container) drive the host Docker daemon through the
# mounted socket — same trusted-agent model as gh. Only the `dev` service gets
# the socket mount; the `worker` service never does.
FROM docker:27-cli AS docker-cli

FROM python:3.14-slim

# Install system dependencies: build toolchain (backend package + psycopg),
# and curl/git for mise + general dev work.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ca-certificates \
    git \
    gcc \
    libpq-dev \
    zsh \
    && rm -rf /var/lib/apt/lists/*

# zsh as the default interactive shell for the sandbox. This is cosmetic for
# the runtime (uvicorn/vite/arq all use /bin/bash / shebang-less exec), but
# `docker compose exec dev` / `make sandbox` land in zsh. The prompts for both
# zsh and bash (with the [SANDBOX] badge + terminal title) come from
# dev-sandbox-rc.sh, installed at /etc/profile.d/00-dev-sandbox.sh so login
# shells (e.g. `zsh -lc` via `make opencode`) pick it up automatically; the rc
# files source it for interactive non-login shells. The container HOME is not
# bind-mounted, so image-level rc files keep the badge stable across rebuilds;
# user tweaks belong in the host-mounted workspace.
COPY dev-sandbox-rc.sh /etc/profile.d/00-dev-sandbox.sh
RUN chsh -s /usr/bin/zsh root \
    && printf '%s\n' \
        '[ -f /etc/profile.d/00-dev-sandbox.sh ] && . /etc/profile.d/00-dev-sandbox.sh' \
        > /root/.zshrc \
    && printf '%s\n' \
        '[ -f /etc/profile.d/00-dev-sandbox.sh ] && . /etc/profile.d/00-dev-sandbox.sh' \
        > /root/.bashrc \
    && printf '%s\n' \
        '[ -f /etc/profile.d/00-dev-sandbox.sh ] && . /etc/profile.d/00-dev-sandbox.sh' \
        > /root/.zprofile

# Copy the pinned mise binary from the stage above.
ARG MISE_VERSION=2025.4.10
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise

# Isolate mise state under /opt so it never mixes with the bind-mounted
# workspace or the /root gh config.
ENV MISE_DATA_DIR=/opt/mise/data \
    MISE_CONFIG_DIR=/opt/mise/config \
    MISE_CACHE_DIR=/opt/mise/cache

# Install the dev toolchain and wire it onto PATH. mise keeps the extracted
# tool dirs under $MISE_DATA_DIR/installs (<tool>/<version>/...): node has a
# bin/node, uv/gh unwrap to their tarball dirs, and node's bin/npm is a
# launcher script that cannot be symlinked (prefix resolution breaks). So:
#   - node/uv/gh binaries are symlinked into /usr/local/bin;
#   - npm/npx/corepack are regenerated as small wrappers against the real
#     node prefix (same layout as the official node tarball launchers).
# `mise install` alone does NOT put tools on PATH outside mise, so this step
# is mandatory for non-interactive shells (dev-entrypoint, arq, alembic).
ARG NODE_VERSION=22
ARG UV_VERSION=latest
ARG GH_VERSION=2.101.0
RUN mise install node@${NODE_VERSION} uv@${UV_VERSION} gh@${GH_VERSION} \
    && NODE_DIR="$(dirname "$(dirname "$(find ${MISE_DATA_DIR}/installs/node -type f -name node | head -1)")")" \
    && UV_DIR="$(dirname "$(find ${MISE_DATA_DIR}/installs/uv -type f -name uv | head -1)")" \
    && GH_DIR="$(dirname "$(find ${MISE_DATA_DIR}/installs/gh -type f -name gh | head -1)")" \
    && ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node \
    && ln -sf "$UV_DIR/uv" /usr/local/bin/uv \
    && ln -sf "$GH_DIR/gh" /usr/local/bin/gh \
    && printf '#!/bin/sh\nexec "%s/bin/node" "%s/lib/node_modules/npm/bin/npm-cli.js" "$@"\n' "$NODE_DIR" "$NODE_DIR" > /usr/local/bin/npm \
    && printf '#!/bin/sh\nexec "%s/bin/node" "%s/lib/node_modules/npm/bin/npx-cli.js" "$@"\n' "$NODE_DIR" "$NODE_DIR" > /usr/local/bin/npx \
    && printf '#!/bin/sh\nexec "%s/bin/node" "%s/lib/node_modules/corepack/dist/corepack.js" "$@"\n' "$NODE_DIR" "$NODE_DIR" > /usr/local/bin/corepack \
    && chmod +x /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && node --version && npm --version && uv --version && gh --version

# Wire the docker CLI + compose plugin onto the image (see docker-cli stage).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN docker --version && docker compose version

# Set working directory
WORKDIR /sandbox/ai-document-platform

# Bake backend dependencies into /opt/backend-venv (NOT /sandbox/ai-document-platform/backend/.venv:
# the workspace bind mount shadows /sandbox/ai-document-platform at runtime, and venv interpreter
# symlinks are path-specific, so the baked venv must live outside /sandbox/ai-document-platform).
# The bind-mounted source at runtime stays in sync with this lockfile via
# `uv sync` whenever pyproject.toml/uv.lock change.
ENV UV_PROJECT_ENVIRONMENT=/opt/backend-venv
COPY backend/ /sandbox/ai-document-platform/backend/
RUN cd /sandbox/ai-document-platform/backend && uv sync --frozen

# Keep the container alive when started without an explicit command; the dev
# and worker compose services override this with their real entrypoints.
CMD ["sleep", "infinity"]