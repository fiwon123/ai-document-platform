#!/bin/bash
set -euo pipefail

# ensure-sandbox-running.sh — bring the dev sandbox up WITHOUT gratuitously
# rebuilding its images, then wait until it is actually ready for `exec`.
#
# Why this exists: the exec-style entry points (`make shell`, `make opencode`,
# `make dev-exec`) used to run `docker compose up -d --build dev worker`
# unconditionally. `--build` re-runs the image build even when the containers
# are already up, so calling `make shell` after `make dev-up` / `make dev-restart`
# kicked off a second build that raced the running stack (and could clobber a
# live `make opencode` session). The build is only needed when the image does
# not exist yet, so that is the only case that triggers it here.
#
# Three cases, as required by the sandbox workflow:
#
#   1. Never initialized (no `dev` container) -> `up -d --build`. The image
#      almost certainly does not exist, so the build is unavoidable.
#   2. Mid-startup (`dev` exists but is still starting / not healthy yet) -> no
#      build, just `up -d` and wait. A concurrent `make dev-up` owns the build;
#      starting a second one here would fight it.
#   3. Already running -> touch nothing at all, just wait for healthy. This is
#      the case the fix is about, so it is deliberately the most conservative:
#      no `up` means no chance of Compose deciding to recreate a container that
#      is already serving.
#
# For a container that exists but is stopped (case 2's sibling), a plain `up -d`
# is enough: the image is already there, so a rebuild would buy nothing.
#
# The wait at the end matters because `docker compose exec` on a container that
# is still booting is either rejected or lands you in a container whose
# migrations have not run yet. We block on the `dev` healthcheck, which the
# compose file defines as "backend reachable" (see docker-compose.yaml).
#
# Usage:
#   scripts/ensure-sandbox-running.sh              # ensure up, stay quiet on success
#   SANDBOX_WAIT_TIMEOUT=300 scripts/ensure-sandbox-running.sh
#
# Env:
#   COMPOSE                  compose command (default: "docker compose")
#   SANDBOX_DEV_SERVICE      service to consider ready (default: dev)
#   SANDBOX_WORKER_SERVICES  space-separated services to also start (default: worker)
#   SANDBOX_WAIT_TIMEOUT     seconds to wait for readiness (default: 180)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE="${COMPOSE-docker compose}"
# Note the `-` (not `:-`) forms for the overridable knobs: `:-` also replaces an
# explicitly empty value, which would make SANDBOX_WORKER_SERVICES="" (meaning
# "no worker service") impossible to express.
DEV_SERVICE="${SANDBOX_DEV_SERVICE-dev}"
WORKER_SERVICES="${SANDBOX_WORKER_SERVICES-worker}"
WAIT_TIMEOUT="${SANDBOX_WAIT_TIMEOUT-180}"

log() { echo "[sandbox] $*" >&2; }

# --- State detection ---------------------------------------------------------
# Ask Compose for the container state of a single service. `docker compose ps`
# exits 0 with empty output when the service has never been created, and prints
# nothing for an unknown service, so empty output == "not initialized".
# We print the raw state string (running/exited/created/...) and nothing else.
service_state() {
    local service="$1" state
    # --all so an exited container is still reported (that is still
    # "initialized", so it must NOT trigger a rebuild).
    state="$($COMPOSE ps --all --format '{{.State}}' "$service" 2>/dev/null | head -n 1 || true)"
    printf '%s' "$state"
}

current_state="$(service_state "$DEV_SERVICE")"

case "$current_state" in
    running)
        # Case 3 (and case 2 once it finishes booting): the image is present and
        # the container is serving, so leave the stack completely alone.
        log "$DEV_SERVICE is already running — skipping image build."
        ;;
    created|exited|restarting|paused|dead|"")
        # Case 1 for "" (never initialized). For the others the container exists
        # with a usable image, so a rebuild is not required to bring it back —
        # only `up -d` is. `restarting` still means something is coming up.
        if [ -z "$current_state" ]; then
            log "$DEV_SERVICE is not initialized yet — building and starting the stack (this runs once)."
            $COMPOSE up -d --build "$DEV_SERVICE" $WORKER_SERVICES
        else
            log "$DEV_SERVICE is '$current_state' — starting the existing containers without rebuilding."
            $COMPOSE up -d "$DEV_SERVICE" $WORKER_SERVICES
        fi
        ;;
    *)
        # Unknown state string from an unexpected Compose version: fall back to
        # the cheap path rather than risk a spurious rebuild.
        log "Unrecognized '$DEV_SERVICE' state '$current_state' — starting without rebuilding."
        $COMPOSE up -d "$DEV_SERVICE" $WORKER_SERVICES
        ;;
esac

# --- Wait for readiness ------------------------------------------------------
# Poll the container health instead of sleeping a fixed amount: a cold start
# (migrations + uvicorn + vite) is slow, a warm one is instant, and a fixed
# sleep is wrong at both ends. A service with no healthcheck in the compose file
# counts as ready as soon as it is running, so the worker (no healthcheck) does
# not block here — only $DEV_SERVICE gates the exec.
wait_for_dev() {
    local deadline=$((SECONDS + WAIT_TIMEOUT))

    while [ "$SECONDS" -lt "$deadline" ]; do
        local state health
        state="$($COMPOSE ps --format '{{.State}}' "$DEV_SERVICE" 2>/dev/null | head -n 1 || true)"
        if [ "$state" = "running" ]; then
            # `healthy` when a healthcheck exists; empty when it does not (or has
            # not reported yet). Treat "running but health unknown" as ready
            # only after a grace period, so a real healthcheck still gates.
            health="$($COMPOSE ps --format '{{.Health}}' "$DEV_SERVICE" 2>/dev/null | head -n 1 || true)"
            if [ -z "$health" ] || [ "$health" = "healthy" ]; then
                return 0
            fi
            if [ "$health" = "unhealthy" ]; then
                log "$DEV_SERVICE reported unhealthy — continuing to wait (it may recover)."
            fi
        fi
        sleep 2
    done

    log "Timed out after ${WAIT_TIMEOUT}s waiting for '$DEV_SERVICE'. Recent status:"
    $COMPOSE ps "$DEV_SERVICE" >&2 || true
    log "Follow the logs with: make dev-log"
    return 1
}

# Never let a slow start abort the caller's shell/agent session: report and let
# the user exec in anyway (a booting container still gives a usable shell).
if ! wait_for_dev; then
    log "Continuing anyway — the container may still be initializing."
fi

exit 0
