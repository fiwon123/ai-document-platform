"""Behavioural tests for the smoke test's wait logic.

`infra/scripts/smoke-test.sh` waits on four workloads: the `job/migrate` Job and
three Deployments. Before #673 one generic function did all four with
`kubectl rollout status`, which has no status viewer for `batch/Job` -- so the
`job/migrate` check returned the same failure whatever the Job was doing, burned
its whole 300s budget doing it, and printed an error that read like a failed
migration (#673).

These are behavioural tests on purpose. The bug was that a function *always*
returned failure, and no amount of grepping the source can tell "returns 0 when
the Job completes" apart from "returns 1". So the real function is extracted from
the real script and driven with a stub `kubectl` on `PATH`.

The smoke test itself remains the only place this runs against real Jobs, and it
runs in CI; `kubectl`/`kind` are not available in the dev image, so a real-cluster
check could not be reproduced here. That is precisely why the decision logic is
pinned here instead.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "infra" / "scripts" / "smoke-test.sh"

# Drives the stub kubectl. Deliberately answers per subcommand so a test can
# assert *which* kubectl verb was used, not just the exit code: a Job that
# succeeded via `rollout status` would still be the bug wearing a disguise.
STUB_KUBECTL = r"""#!/usr/bin/env bash
# Stub kubectl for the smoke test's wait logic. State comes from the environment.
set -u

log="${STUB_LOG:-/dev/null}"

# Drop `-n <ns>` / `--namespace <ns>` so the subcommand is args[0].
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--namespace) shift 2 || true ;;
    *) args+=("$1"); shift ;;
  esac
done

count_file="${STUB_COUNT:-/dev/null}"
count=0
[ -f "${count_file}" ] && count="$(cat "${count_file}")"
count=$(( count + 1 ))
printf '%s' "${count}" > "${count_file}"

sub="${args[0]:-}"
# Log the subcommand first, without the namespace flags, so a test can assert
# *which* kubectl verb was used.
printf '%s %s\n' "${sub}" "${args[*]:1}" >> "${log}"

case "${sub}" in
  wait)
    # A Job that completes only on the Nth call, so "not yet" is genuinely
    # different from "never".
    if [ -n "${STUB_WAIT_SUCCESS_AT:-}" ] && [ "${count}" -ge "${STUB_WAIT_SUCCESS_AT}" ]; then
      exit 0
    fi
    exit "${STUB_WAIT_RC:-1}"
    ;;
  get)
    # `get job <name> -o jsonpath=...`. The two fields are modelled separately,
    # because reading the wrong one is the specific mistake #673 warns about:
    # `status.failed` counts retries, the `Failed` condition is terminal.
    case "${args[*]:1}" in
      *status.failed*) printf '%s' "${STUB_JOB_RETRIES:-0}" ;;
      *Failed*)        printf '%s' "${STUB_JOB_FAILED_COND:-}" ;;
      *)               printf '%s' "" ;;
    esac
    exit 0
    ;;
  rollout)
    exit "${STUB_ROLLOUT_RC:-1}"
    ;;
esac
exit 0
"""


def _extract_wait_function() -> str:
    """Pull `wait_for_rollout` out of the script verbatim.

    Extracted rather than reimplemented so the test exercises the shipped code.
    If the function cannot be found the test fails loudly here instead of
    silently passing against a copy that has drifted.
    """
    lines = SCRIPT.read_text().splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith("wait_for_rollout() {"))
    except StopIteration:  # pragma: no cover - only if the script is restructured
        pytest.fail(f"wait_for_rollout() not found in {SCRIPT}")
    try:
        end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")
    except StopIteration:  # pragma: no cover
        pytest.fail(f"end of wait_for_rollout() not found in {SCRIPT}")
    return "\n".join(lines[start : end + 1])


@pytest.fixture(scope="module")
def wait_function() -> str:
    return _extract_wait_function()


def run_wait(
    wait_function: str,
    target: str,
    timeout_secs: int,
    tmp_path: Path,
    **env: str,
) -> tuple[int, str, str, list[str]]:
    """Run wait_for_rollout(target) against a stub kubectl.

    Returns (exit_code, stdout, stderr, kubectl_invocations).
    """
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    kubectl = bindir / "kubectl"
    kubectl.write_text(STUB_KUBECTL)
    kubectl.chmod(0o755)

    log = tmp_path / "calls.log"
    count = tmp_path / "count"
    script = (
        "set -uo pipefail\n"
        'NAMESPACE="ai-platform"\n'
        f"{wait_function}\n"
        f'wait_for_rollout "{target}" {timeout_secs}\n'
    )
    # Absolute interpreter path: avoids S607 (partial executable path) and does not
    # depend on the caller's PATH -- which matters here, because PATH is overridden
    # to put the stub kubectl first.
    # S603: the script is assembled from the function extracted from smoke-test.sh
    # and two literal arguments passed by the tests. No untrusted input.
    proc = subprocess.run(  # noqa: S603
        ["/bin/bash", "-c", script],
        capture_output=True,
        text=True,
        timeout=timeout_secs + 60,
        env={
            "PATH": f"{bindir}:{shutil.which('bash') and '/usr/bin:/bin'}",
            "STUB_LOG": str(log),
            "STUB_COUNT": str(count),
            **env,
        },
    )
    calls = log.read_text().splitlines() if log.exists() else []
    return proc.returncode, proc.stdout, proc.stderr, calls


def test_the_function_is_still_extractable(wait_function: str) -> None:
    """Guard the extraction itself, so a restructure fails loudly."""
    assert "wait_for_rollout" in wait_function
    assert "SECONDS" in wait_function


def test_a_completed_job_is_reported_as_success(wait_function: str, tmp_path: Path) -> None:
    """The bug, stated as the thing that must be true.

    #673: `job/migrate` completed in 262s of a 300s budget and the smoke test
    still failed, because `rollout status` has no Job status viewer.
    """
    code, out, _err, calls = run_wait(
        wait_function, "job/migrate", 30, tmp_path, STUB_WAIT_SUCCESS_AT="1"
    )
    assert code == 0, f"a completed Job must exit 0; got {code}"
    assert "completed" in out


def test_a_job_is_never_waited_on_with_rollout_status(
    wait_function: str, tmp_path: Path
) -> None:
    """No `rollout status` call at all for a Job -- the exact verb that broke it."""
    _code, _out, _err, calls = run_wait(
        wait_function, "job/migrate", 30, tmp_path, STUB_WAIT_SUCCESS_AT="1"
    )
    assert not any("rollout" in call for call in calls), (
        f"a Job must not go through `kubectl rollout status`; calls were {calls}"
    )
    assert any(call.startswith("wait ") for call in calls), calls


def test_a_job_that_completes_late_still_succeeds(wait_function: str, tmp_path: Path) -> None:
    """"Not complete yet" must be distinguished from "never"."""
    code, out, _err, calls = run_wait(
        wait_function, "job/migrate", 30, tmp_path, STUB_WAIT_SUCCESS_AT="4"
    )
    assert code == 0
    assert "completed" in out
    # Polled rather than giving up on the first miss. Each iteration consults the
    # Failed condition as well as completion, so a long wait is interleaved with
    # the failure check rather than a single blocking call.
    waits = sum(1 for call in calls if call.startswith("wait "))
    assert waits >= 2, f"expected repeated polling, saw {waits}: {calls}"
    assert any(call.startswith("get ") for call in calls), calls


def test_a_job_that_never_completes_fails_within_its_budget(
    wait_function: str, tmp_path: Path
) -> None:
    code, _out, err, _calls = run_wait(
        wait_function,
        "job/migrate",
        3,
        tmp_path,
        STUB_WAIT_RC="1",
        STUB_JOB_FAILED_COND="",
    )
    assert code == 1
    # The message must name the Job and the budget, not replay a kubectl error
    # that reads like the Job's status.
    assert "migrate" in err
    assert "3s" in err
    assert "status viewer" not in err


def test_an_exhausted_job_fails_promptly(wait_function: str, tmp_path: Path) -> None:
    """`backoffLimit: 3` -- once the retries are gone, stop waiting.

    Without this the run spends its entire budget polling a Job that has already
    given up, which is the behaviour the function's own comment claims not to
    have.
    """
    code, _out, err, calls = run_wait(
        wait_function,
        "job/migrate",
        60,
        tmp_path,
        STUB_WAIT_RC="1",
        STUB_JOB_FAILED_COND="True",
    )
    assert code == 1
    assert "failed" in err
    # Promptly: nowhere near the 60s budget.
    assert sum(1 for call in calls if call.startswith("wait ")) <= 3


def test_a_retried_job_is_not_treated_as_failed(wait_function: str, tmp_path: Path) -> None:
    """`status.failed` counts retries and must NOT be read as terminal.

    The migrate Job is `backoffLimit: 3` with `restartPolicy: OnFailure`, so a Job
    that failed once and then succeeded has a non-zero retry count. Reading
    `status.failed` as terminal would fail a healthy migration -- trading one
    false failure for another. Here the Job has already retried once
    (`status.failed` = 1), carries no `Failed` condition, and then completes.
    """
    code, out, _err, _calls = run_wait(
        wait_function,
        "job/migrate",
        30,
        tmp_path,
        STUB_WAIT_SUCCESS_AT="4",
        STUB_JOB_RETRIES="1",
        STUB_JOB_FAILED_COND="",
    )
    assert code == 0, "a retrying Job that then completes must still exit 0"
    assert "completed" in out


def test_a_deployment_still_uses_rollout_status(wait_function: str, tmp_path: Path) -> None:
    """The fix must not change how Deployments are waited on."""
    code, _out, _err, calls = run_wait(
        wait_function,
        "deploy/backend",
        30,
        tmp_path,
        STUB_ROLLOUT_RC="0",
    )
    assert code == 0
    assert any(call.startswith("rollout status") for call in calls), calls


def test_a_deployment_that_never_rolls_out_fails(wait_function: str, tmp_path: Path) -> None:
    code, _out, _err, calls = run_wait(
        wait_function,
        "deploy/frontend",
        3,
        tmp_path,
        STUB_ROLLOUT_RC="1",
    )
    assert code == 1
    # Deployments keep their existing behaviour: retried `rollout status`, and the
    # rollout status output is what gets surfaced on failure.
    assert sum(1 for call in calls if call.startswith("rollout status")) >= 1, calls


def test_every_target_in_the_smoke_test_is_handled(wait_function: str, tmp_path: Path) -> None:
    """The four targets the script actually waits on, all reachable.

    A target kind the function does not recognise silently falls through to
    `rollout status`, which is how the Job got here. This asserts the set the
    script iterates is covered by the kinds the function branches on.
    """
    script = SCRIPT.read_text()
    assert "job/migrate deploy/backend deploy/worker deploy/frontend" in script, (
        "the rollout loop's target list changed; re-check the kind handling"
    )
    for target in ("job/migrate", "deploy/backend", "deploy/worker", "deploy/frontend"):
        code, _out, _err, calls = run_wait(
            wait_function,
            target,
            3,
            tmp_path,
            STUB_WAIT_SUCCESS_AT="1",
            STUB_ROLLOUT_RC="0",
        )
        assert code == 0, f"{target} did not resolve: exit {code}"
        assert calls, f"{target} never reached kubectl"
