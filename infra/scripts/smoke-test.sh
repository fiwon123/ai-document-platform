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

# The migrate Job's logs, captured by a watcher running for the whole test.
#
# This has to be a watcher, not a snapshot taken while waiting on the migrate
# target, because the Job's pod is gone before that wait even starts: a Job with
# `backoffLimit` deletes its pod once the retries are exhausted, the Job lives
# ~2 minutes, and `job/migrate` is checked last in the rollout loop — after
# backend has burned 300s and worker another 300s. Snapshotting from inside that
# loop therefore started ~7 minutes after the evidence was deleted (#655, #662).
MIGRATE_SNAPSHOT_FILE="$(mktemp)"
MIGRATE_WATCH_STOP="$(mktemp)"
rm -f "${MIGRATE_WATCH_STOP}"   # absence of this file is what keeps the watcher running
MIGRATE_WATCH_PID=""

stop_migrate_watcher() {
  [ -n "${MIGRATE_WATCH_PID}" ] || return 0
  touch "${MIGRATE_WATCH_STOP}"
  wait "${MIGRATE_WATCH_PID}" 2>/dev/null || true
  MIGRATE_WATCH_PID=""
}

# Stops the watcher and removes its temp files. Registered as an EXIT trap so the
# background process cannot outlive the script, including on an early `exit`.
cleanup() {
  stop_migrate_watcher
  rm -f "${MIGRATE_WATCH_STOP}" "${MIGRATE_SNAPSHOT_FILE}" "${MIGRATE_SNAPSHOT_FILE}.new"
}
trap cleanup EXIT

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

# Re-capture on every pass, so a poll taken while the pod is alive is never
# overwritten by the "container not found" error from a poll taken after it was
# collected. Run in the background for the whole test: it is the only thing that
# can see these logs, because neither the rollout wait nor the diagnostics dump
# happens while the pod still exists.
watch_migrate_logs() {
  local pod out
  while [ ! -f "${MIGRATE_WATCH_STOP}" ]; do
    pod="$(kubectl -n "${NAMESPACE}" get pods -l job-name=migrate \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [ -n "${pod}" ]; then
      # `--previous` matters as much as the current container: a failing Job
      # restarts in place, so the crashed attempt is often the one holding the
      # reason.
      out="$(kubectl -n "${NAMESPACE}" logs "${pod}" --all-containers --tail=60 2>&1 || true)"
      out="${out}"$'\n'"$(kubectl -n "${NAMESPACE}" logs "${pod}" --all-containers \
        --tail=60 --previous 2>&1 || true)"
      if [ -n "$(printf '%s' "${out}" | tr -d '[:space:]')" ]; then
        # Write then move, so a concurrent dump never reads a half-written file.
        {
          echo "(pod ${pod})"
          printf '%s\n' "${out}"
        } > "${MIGRATE_SNAPSHOT_FILE}.new"
        mv "${MIGRATE_SNAPSHOT_FILE}.new" "${MIGRATE_SNAPSHOT_FILE}"
      fi
    fi
    sleep 2
  done
}

# Started before anything waits on a rollout, because the migrate Job's pod does
# not survive the backend's own 300s rollout wait.
watch_migrate_logs &
MIGRATE_WATCH_PID=$!

# Poll rather than block in one long `rollout status`, so a failing Job exits this
# loop early instead of always burning the full timeout.
wait_for_rollout() {
  local target="$1" timeout_secs="$2" out=""
  local deadline=$(( SECONDS + timeout_secs ))

  # `kubectl rollout status` has no status viewer for Job.batch. It returns
  # "no status viewer has been implemented for Job.batch" whatever the Job is
  # actually doing, so this check could never pass -- and after the full budget it
  # printed that error as if it were the Job's status, which reads like a failed
  # migration when the migration is fine. Cost five minutes per run to be wrong
  # about a Job that completed (run 37315248854, #673).
  #
  # Jobs are therefore waited on with `kubectl wait --for=condition=complete`,
  # the same gate the backend and worker init containers already use
  # (backend.yaml:61-73).
  case "${target}" in
    job/*)
      local name="${target#job/}"
      while [ "${SECONDS}" -lt "${deadline}" ]; do
        if kubectl -n "${NAMESPACE}" wait --for=condition=complete "${target}" \
            --timeout=5s >/dev/null 2>&1; then
          printf '%s\n' "job/${name} completed"
          return 0
        fi
        # Deliberately the `Failed` condition and NOT `status.failed`: this Job is
        # `backoffLimit: 3` with `restartPolicy: OnFailure`, so `status.failed`
        # counts retries and is non-zero on a Job that goes on to succeed. Reading
        # it as terminal would fail a healthy migration. The condition is only set
        # once the retries are exhausted -- the point at which waiting out the
        # remaining budget is pure delay.
        if [ "$(kubectl -n "${NAMESPACE}" get job "${name}" \
                -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' \
                2>/dev/null)" = "True" ]; then
          printf '%s\n' "job/${name} failed (backoffLimit exhausted)" >&2
          return 1
        fi
        sleep 2
      done
      printf 'job/%s did not complete within %ss\n' "${name}" "${timeout_secs}" >&2
      return 1
      ;;
  esac

  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if out="$(kubectl -n "${NAMESPACE}" rollout status "${target}" --timeout=10s 2>&1)"; then
      printf '%s\n' "${out}"
      return 0
    fi
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
  if [ -s "${MIGRATE_SNAPSHOT_FILE}" ]; then
    echo "--- logs job/migrate (captured while the pod still existed) ---" >&2
    cat "${MIGRATE_SNAPSHOT_FILE}" >&2
  else
    # Deliberately loud. An earlier version printed "no snapshot was captured",
    # which reads like the Job produced no output rather than like the capture
    # itself being broken — and that ambiguity is what let #656 look correct in
    # review and print nothing in CI (#662).
    echo "--- logs job/migrate: NOTHING CAPTURED. This is a gap in the test's" >&2
    echo "    diagnostics, not a statement about the Job: the watcher never saw a" >&2
    echo "    migrate pod with container output. ---" >&2
  fi
}

echo "==> Waiting for backend/frontend rollouts"
ROLLOUT_FAILED=0
# Every workload is attempted and every failure reported: `set -e` would abort on
# the first one, so a single bad workload hid the state of the other two.
#
# `job/migrate` is first because it is the prerequisite for the other two and the
# only one whose logs stop existing. Checking it last meant paying ~10 minutes to
# find out that the migration had failed (#662).
for target in job/migrate deploy/backend deploy/worker deploy/frontend; do
  if wait_for_rollout "${target}" 300; then
    ok "rollout ${target}"
  else
    fail "rollout ${target} did not complete"
    ROLLOUT_FAILED=1
  fi
done

if [ "${ROLLOUT_FAILED}" = "1" ]; then
  stop_migrate_watcher
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