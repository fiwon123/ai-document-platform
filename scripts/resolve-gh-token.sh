#!/bin/bash
set -euo pipefail

# resolve-gh-token.sh — pick the GitHub credential the dev sandbox should use.
#
# The `dev` service forwards the host's GitHub token (see the GH_TOKEN entry in
# docker-compose.yaml) so the sandboxed agent can drive the issue → branch → PR
# workflow from inside the container. The read-only ~/.config/gh mount cannot do
# that on its own: the host token normally lives in the OS keyring, so
# hosts.yml carries no `oauth_token` and the container — which has no keyring
# socket — ends up unauthenticated. The token therefore has to arrive as an env
# var, resolved from the host at up-time.
#
# Resolution order (mirrors gh's own precedence):
#   1. $GH_TOKEN       — explicit, wins
#   2. $GITHUB_TOKEN   — explicit
#   3. `gh auth token` — keyring or ~/.config/gh/hosts.yml
#
# Usage:
#   scripts/resolve-gh-token.sh           # print the token on stdout, or nothing
#   scripts/resolve-gh-token.sh --check   # validate + explain; prints no token
#
# `--check` exists because `gh auth token` exits 0 even when NO credential
# exists, so it cannot serve as a validity test. It resolves the token the same
# way, then asks GitHub whether the credential is actually accepted:
#
#   accepted → exit 0, silent
#   rejected → exit 1 (fatal). A rejected token is worse than none: inside the
#              container gh looks authenticated and 401s on every call, and it
#              also breaks gh and git on the host (git delegates to
#              `gh auth git-credential`).
#   absent   → exit 0 + warning. The sandbox is still useful for local work, gh
#              is simply not authenticated.
#   offline  → exit 0 + warning. Unverifiable is not the same as invalid, so a
#              network hiccup must never block starting the sandbox.
#
# The token is only ever written to stdout — never to stderr, never to a log.

warn() { echo "WARN: $*" >&2; }
error() { echo "ERROR: $*" >&2; }

resolve_token() {
    if [ -n "${GH_TOKEN:-}" ]; then
        printf '%s' "$GH_TOKEN"
    elif [ -n "${GITHUB_TOKEN:-}" ]; then
        printf '%s' "$GITHUB_TOKEN"
    else
        # Unset both so gh cannot pick up a stale token from the environment and
        # reports the keyring / config credential instead.
        env -u GH_TOKEN -u GITHUB_TOKEN gh auth token 2>/dev/null || true
    fi
}

# Ask GitHub whether the credential is accepted. Echoes the combined output and
# returns gh's exit code; callers classify the failure from the output.
api_probe() {
    local out rc
    if command -v timeout >/dev/null 2>&1; then
        out="$(env -u GITHUB_TOKEN GH_TOKEN="$1" timeout 20 gh api user 2>&1)" && rc=0 || rc=$?
    else
        out="$(env -u GITHUB_TOKEN GH_TOKEN="$1" gh api user 2>&1)" && rc=0 || rc=$?
    fi
    printf '%s' "$out"
    return "$rc"
}

token="$(resolve_token)"

if [ "${1:-}" != "--check" ]; then
    # Resolution mode: the token is the payload, and it goes only to stdout.
    printf '%s' "$token"
    exit 0
fi

if [ -z "$token" ]; then
    warn "no GitHub credential found — 'gh' will not be authenticated in the dev sandbox."
    warn "  Fix: gh auth login   (or: make dev-up GH_TOKEN=<pat>)"
    exit 0
fi

probe_output="$(api_probe "$token" || true)"

if printf '%s' "$probe_output" | grep -qiE 'bad credentials|HTTP 401|requires authentication|invalid token'; then
    if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
        error "the GitHub token in your environment is rejected by GitHub."
        error "  A GH_TOKEN/GITHUB_TOKEN in the shell takes precedence over your keyring"
        error "  login, so a stale one shadows a working credential and would be injected"
        error "  into the dev container (it also breaks 'gh' and 'git' on the host)."
        error "  Fix: unset GH_TOKEN GITHUB_TOKEN, or refresh the token, then retry."
    else
        error "the GitHub credential for the host user is rejected by GitHub."
        error "  Fix: gh auth login   (or: make dev-up GH_TOKEN=<pat>)"
    fi
    exit 1
fi

if printf '%s' "$probe_output" | grep -qiE 'error connecting|dial tcp|no such host|i/o timeout|connection reset|connection refused|could not resolve|network is unreachable|TLS handshake'; then
    warn "could not reach GitHub to verify the credential (offline?); continuing."
    warn "  'gh' may not work in the dev sandbox until the network is back."
    exit 0
fi

if ! printf '%s' "$probe_output" | grep -q '"login"'; then
    warn "unexpected response while verifying the GitHub credential; continuing."
    exit 0
fi

exit 0
