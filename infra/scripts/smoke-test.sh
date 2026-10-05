#!/usr/bin/env bash
# End-to-end smoke test against a local Kind cluster.
#
# Bootstraps the full stack from the dev overlay (build images → push to the
# local registry → apply manifests) and asserts:
#   1. backend /v1/health returns 200
#   2. frontend serves the SPA (HTTP 200)
#   3. one API round-trip succeeds: register → login → upload → status → search
#
# Usage:
#   ./infra/scripts/smoke-test.sh
#
# Requires (host or CI, NOT the dev container): docker, kind, kubectl,
# curl, python3 (JSON parsing) and network access for image builds.
# Reuses setup-kind.sh + kind-load-images.sh as the bootstrap.

set -euo pipefail

CLUSTER_NAME="ai-platform"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:18001}"   # Kind hostPort -> backend NodePort
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:18080}" # Kind hostPort -> frontend NodePort
NAMESPACE="ai-platform"
SMOKE_USER="smoke-$(date +%s)"
SMOKE_PASS="SmokeTest-$(date +%s)!"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok()   { echo "ok:   $*"; }

# Most recent migrate Job logs seen while its pod still existed. A Job with
# `backoffLimit` deletes its pod once the retries are exhausted, so the reason a
# migration failed is only readable *during* the wait — by the time the rollout
# gives up, `kubectl logs` has nothing left to return (#655).
MIGRATE_LOG_SNAPSHOT=""

for cmd in docker kind kubectl kustomize curl python3; do
  command -v "${cmd}" >/dev/null 2>&1 || { echo "ERROR: '${cmd}' is required but not installed"; exit 1; }
done

# --- Bootstrap ------------------------------------------------------------
if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "==> Creating Kind cluster + local registry"
  "${SCRIPT_DIR}/setup-kind.sh"
else
  echo "==> Kind cluster '${CLUSTER_NAME}' already exists"
fi

echo "==> Building + loading images into the cluster"
"${SCRIPT_DIR}/kind-load-images.sh"

echo "==> Applying the dev overlay"
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null
kustomize build "${ROOT_DIR}/infra/k8s/overlays/dev" | kubectl apply -f -

# Keep the newest non-blank capture, so a poll taken after the pod vanished
# cannot overwrite a good one with an error message.
snapshot_migrate_logs() {
  local pod out
  pod="$(kubectl -n "${NAMESPACE}" get pods -l job-name=migrate \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "${pod}" ] || return 0

  # `--previous` matters as much as the current container: a failing Job restarts
  # in place, so the crashed attempt is usually the one holding the reason.
  out="$(kubectl -n "${NAMESPACE}" logs "${pod}" --all-containers --tail=60 2>&1 || true)"
  out="${out}"$'\n'"$(kubectl -n "${NAMESPACE}" logs "${pod}" --all-containers \
    --tail=60 --previous 2>&1 || true)"
  [ -n "$(printf '%s' "${out}" | tr -d '[:space:]')" ] || return 0

  MIGRATE_LOG_SNAPSHOT="(pod ${pod})
${out}"
}

# Poll rather than block in one long `rollout status`, so snapshot_migrate_logs
# can run while the pod is still there. A failing Job also exits this loop early
# instead of always burning the full timeout.
wait_for_rollout() {
  local target="$1" timeout_secs="$2" out=""
  local deadline=$(( SECONDS + timeout_secs ))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if out="$(kubectl -n "${NAMESPACE}" rollout status "${target}" --timeout=10s 2>&1)"; then
      printf '%s\n' "${out}"
      return 0
    fi
    if [ "${target}" = "job/migrate" ]; then snapshot_migrate_logs; fi
    sleep 2
  done
  printf '%s\n' "${out}" >&2
  return 1
}

# Dump why a workload is not coming up. Without this the only evidence a rollout
# failed is the word "timed out": no pod state, no events, no container output.
# That matters more than usual here, because neither workflow runs on a `dev`
# push — a broken overlay is invisible until a release PR, and then each attempt
# costs a 7-minute cycle with nothing in the log to act on.
dump_diagnostics() {
  local why="$1"
  echo "" >&2
  echo "==> DIAGNOSTICS: ${why}" >&2
  echo "--- pods ---" >&2
  kubectl -n "${NAMESPACE}" get pods -o wide >&2 2>&1 || true
  echo "--- events (most recent first) ---" >&2
  kubectl -n "${NAMESPACE}" get events --sort-by=.lastTimestamp >&2 2>&1 \
    | tail -40 || true

  # Anything not Running/Ready, plus the migrate job — a failed migration leaves
  # the backend waiting on a schema that does not exist, and that job's own logs
  # are the only place the reason appears.
  local pod
  for pod in $(kubectl -n "${NAMESPACE}" get pods \
      --field-selector=status.phase!=Succeeded \
      -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    case "$(kubectl -n "${NAMESPACE}" get pod "${pod}" \
            -o jsonpath='{.status.phase}/{.status.containerStatuses[*].ready}' 2>/dev/null)" in
      Running/True*|Succeeded/*) continue ;;
    esac
    echo "--- describe ${pod} ---" >&2
    kubectl -n "${NAMESPACE}" describe pod "${pod}" >&2 2>&1 \
      | sed -n '/^Events:/,$p' | tail -25 || true
    echo "--- logs ${pod} (previous) ---" >&2
    kubectl -n "${NAMESPACE}" logs "${pod}" --all-containers --tail=60 \
      --previous >&2 2>&1 || true
  done

  # Last, because it is the answer to "why did the migration fail" — and the only
  # section that still exists after the Job's pod has been garbage collected.
  if [ -n "${MIGRATE_LOG_SNAPSHOT}" ]; then
    echo "--- logs job/migrate (captured while the pod still existed) ---" >&2
    printf '%s\n' "${MIGRATE_LOG_SNAPSHOT}" >&2
  else
    echo "--- logs job/migrate: no snapshot was captured ---" >&2
  fi
}

echo "==> Waiting for backend/frontend rollouts"
ROLLOUT_FAILED=0
# Every workload is attempted and every failure reported: `set -e` would abort on
# the first one, so a single bad workload hid the state of the other two.
for target in deploy/backend deploy/worker deploy/frontend job/migrate; do
  if wait_for_rollout "${target}" 300; then
    ok "rollout ${target}"
  else
    fail "rollout ${target} did not complete"
    ROLLOUT_FAILED=1
  fi
done

if [ "${ROLLOUT_FAILED}" = "1" ]; then
  dump_diagnostics "at least one rollout did not complete"
  echo "" >&2
  echo "SMOKE TEST FAILED ✘ (rollouts did not complete; see diagnostics above)" >&2
  exit 1
fi

echo "==> Smoke: backend health"
BACKEND_HEALTH=$(curl -sS -o /dev/null -w '%{http_code}' --retry 20 --retry-delay 3 \
  --retry-all-errors "${BACKEND_URL}/v1/health" || echo 000)
if [ "${BACKEND_HEALTH}" = "200" ]; then ok "GET /v1/health -> 200";
else fail "GET /v1/health -> ${BACKEND_HEALTH} (expected 200)"; fi

echo "==> Smoke: frontend reachability"
FRONTEND_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --retry 20 --retry-delay 3 \
  --retry-all-errors "${FRONTEND_URL}/" || echo 000)
if [ "${FRONTEND_CODE}" = "200" ]; then ok "GET / -> 200";
else fail "GET / -> ${FRONTEND_CODE} (expected 200)"; fi

echo "==> Smoke: API round-trip (register -> login -> upload -> status -> search)"
# 1. Register
REGISTER_CODE=$(curl -sS -o /tmp/smoke-register.json -w '%{http_code}' \
  -X POST "${BACKEND_URL}/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${SMOKE_USER}\",\"password\":\"${SMOKE_PASS}\"}" || echo 000)
if [ "${REGISTER_CODE}" = "200" ] || [ "${REGISTER_CODE}" = "201" ]; then
  ok "register -> ${REGISTER_CODE}"
else fail "register -> ${REGISTER_CODE}"; fi

# 2. Login (OAuth2 form) -> access token
LOGIN_CODE=$(curl -sS -o /tmp/smoke-login.json -w '%{http_code}' \
  -X POST "${BACKEND_URL}/v1/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=${SMOKE_USER}" \
  --data-urlencode "password=${SMOKE_PASS}" || echo 000)
TOKEN=$(python3 -c "import json,sys;print(json.load(open('/tmp/smoke-login.json')).get('access_token',''))" 2>/dev/null || true)
if [ "${LOGIN_CODE}" = "200" ] && [ -n "${TOKEN}" ]; then ok "login -> ${LOGIN_CODE} (token acquired)";
else fail "login -> ${LOGIN_CODE} (token: ${TOKEN:+present}${TOKEN:-missing})"; fi

# 3. Upload a tiny document
printf 'smoke test document content\n' > /tmp/smoke.txt
UPLOAD_CODE=$(curl -sS -o /tmp/smoke-upload.json -w '%{http_code}' \
  -X POST "${BACKEND_URL}/v1/documents/" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@/tmp/smoke.txt" || echo 000)
DOC_ID=$(python3 -c "import json;print(json.load(open('/tmp/smoke-upload.json')).get('id',''))" 2>/dev/null || true)
if [ "${UPLOAD_CODE}" = "201" ] && [ -n "${DOC_ID}" ]; then ok "upload -> ${UPLOAD_CODE} (id ${DOC_ID})";
else fail "upload -> ${UPLOAD_CODE} (id: ${DOC_ID:-none})"; fi

# 4. Status (processing may end in ready OR failed without an embedding key —
#    the API surface is what we assert here)
STATUS_CODE=$(curl -sS -o /tmp/smoke-status.json -w '%{http_code}' \
  "${BACKEND_URL}/v1/documents/${DOC_ID}/status" \
  -H "Authorization: Bearer ${TOKEN}" || echo 000)
STATUS=$(python3 -c "import json;print(json.load(open('/tmp/smoke-status.json')).get('status',''))" 2>/dev/null || true)
if [ "${STATUS_CODE}" = "200" ] && [ -n "${STATUS}" ]; then ok "status -> ${STATUS_CODE} (status: ${STATUS})";
else fail "status -> ${STATUS_CODE} (status: ${STATUS:-none})"; fi

# 5. Search (works with 0 results too — asserts the endpoint round-trip)
SEARCH_CODE=$(curl -sS -o /tmp/smoke-search.json -w '%{http_code}' \
  -X POST "${BACKEND_URL}/v1/search/" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query":"smoke"}' || echo 000)
TOTAL=$(python3 -c "import json;print(json.load(open('/tmp/smoke-search.json')).get('total_count',''))" 2>/dev/null || true)
if [ "${SEARCH_CODE}" = "200" ]; then ok "search -> ${SEARCH_CODE} (total_count: ${TOTAL:-n/a})";
else fail "search -> ${SEARCH_CODE}"; fi

# --- Result ----------------------------------------------------------------
echo
if [ "${FAILED}" = "0" ]; then
  echo "SMOKE TEST PASSED ✔"
  echo "  backend  ${BACKEND_URL}/v1/health"
  echo "  frontend ${FRONTEND_URL}/"
  echo "  user     ${SMOKE_USER}"
  exit 0
else
  echo "SMOKE TEST FAILED ✘"
  exit 1
fi