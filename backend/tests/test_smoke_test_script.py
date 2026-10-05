"""The migrate Job's logs must be captured from apply time, not from poll time (#662).

The smoke test is the only thing that can ever explain a failed migration: the Job
pods are garbage collected when ``backoffLimit`` is exhausted, so once the rollout
gives up there is nothing left to read. Two attempts have already been made to
capture those logs and neither produced anything in CI.

The first attempt (#655) had the smoke test print the Job's logs at the end of the
run, which was simply too late — by then the pod was gone.

The second attempt (#656) snapshotted the logs while polling ``job/migrate``, which
was correct in principle and useless in practice. A failing Job exhausts its
retries and deletes its pod within about two minutes, while the rollout loop was
ordered ``deploy/backend deploy/worker deploy/frontend job/migrate`` and each of
the first two burns a 300s timeout. The migrate poll therefore began roughly seven
minutes *after* the evidence had been deleted, and the capture always came up
empty — while printing ``no snapshot was captured``, which reads like a fact about
the Job rather than like a broken test.

That failure is invisible to review and impossible to reproduce locally, because it
depends on the Job's lifetime being shorter than the rollout wait. The assertions
below pin the two ordering facts that decide it, so the combination cannot come back:

1. the log watcher is started before anything waits on a rollout, and
2. ``job/migrate`` is the first rollout target.

Either one alone would keep the evidence inside the window in which it exists.
Both are also cheap to check statically, which is what runs in CI — a full Kind
smoke test takes minutes and cannot exercise a fast-failing Job, since the rollout
timeout is a hard-coded 300s.
"""

from pathlib import Path

import pytest

SMOKE_TEST = Path(__file__).resolve().parents[2] / "infra/scripts/smoke-test.sh"


@pytest.fixture(scope="module")
def script() -> str:
    return SMOKE_TEST.read_text()


def _line_of(source: str, needle: str) -> int:
    """1-indexed line of the first line containing ``needle``."""
    for number, line in enumerate(source.splitlines(), start=1):
        if needle in line:
            return number
    raise AssertionError(f"{needle!r} not found in {SMOKE_TEST}")


def test_watcher_starts_before_any_rollout_is_waited_on(script: str) -> None:
    """The capture must not depend on reaching the migrate target to have started."""
    started = _line_of(script, "watch_migrate_logs &")
    first_wait = _line_of(script, 'wait_for_rollout "${target}" 300')

    assert started < first_wait, (
        "the migrate log watcher is started after the first rollout wait, so the "
        "Job's pod can be deleted before anything is watching it — this is the "
        "#656 ordering bug"
    )


def test_migrate_is_the_first_rollout_target(script: str) -> None:
    """A prerequisite failure should be found before waiting on its dependents."""
    loop = _line_of(script, "for target in ")
    targets = script.splitlines()[loop - 1].split("for target in ")[1]

    assert targets.split()[0] == "job/migrate", (
        f"expected job/migrate to be checked first, got {targets!r} — a failing "
        "migration is discovered only after backend and worker have each burned "
        "their 300s timeout"
    )


def test_every_workload_is_still_attempted(script: str) -> None:
    """Reordering must not turn into short-circuiting.

    The loop deliberately continues past a failure so one broken workload cannot
    hide the state of the others; `set -e` plus `break`/`exit` would undo that.
    """
    loop = _line_of(script, "for target in ")
    body = script.splitlines()[loop:]
    loop_end = next(
        index for index, line in enumerate(body) if line.strip() == "done"
    )
    loop_body = "\n".join(body[:loop_end])

    for target in ("job/migrate", "deploy/backend", "deploy/worker", "deploy/frontend"):
        assert target in script, f"{target} is no longer smoke-tested"

    assert 'fail "rollout ${target} did not complete"' in loop_body, (
        "a rollout failure must be recorded, not raised"
    )
    assert "ROLLOUT_FAILED=1" in loop_body
    assert "break" not in loop_body
    assert "exit " not in loop_body


def test_snapshot_is_read_from_the_file_the_watcher_writes(script: str) -> None:
    """The dump must consume the captured file, not a variable set during polling."""
    assert 'MIGRATE_SNAPSHOT_FILE="$(mktemp)"' in script
    assert '-s "${MIGRATE_SNAPSHOT_FILE}"' in script, (
        "the diagnostics must read the watcher's file"
    )


def test_no_capture_survives_only_in_a_polled_variable(script: str) -> None:
    """Guard against reintroducing the in-memory variant that could not work.

    The value was assigned inside the rollout loop, so it only ever held a
    snapshot taken at poll time — which, per the module docstring, is always too
    late.
    """
    assert "MIGRATE_LOG_SNAPSHOT" not in script
    assert "snapshot_migrate_logs" not in script


def test_watcher_is_stopped_before_the_snapshot_is_read(script: str) -> None:
    """Stop the background loop first, or the dump races a half-written file."""
    stop = _line_of(script, "stop_migrate_watcher")
    dumped = _line_of(script, "dump_diagnostics ")

    assert stop < dumped, (
        "the watcher must be stopped before dump_diagnostics reads the snapshot"
    )


def test_watcher_cannot_outlive_the_script(script: str) -> None:
    """An EXIT trap is the only thing that stops the watcher on an early exit."""
    assert "trap cleanup EXIT" in script
    assert "stop_migrate_watcher" in script.split("cleanup() {", 1)[1].split("\n}", 1)[0]


def test_missing_snapshot_is_reported_as_a_test_gap(script: str) -> None:
    """Say what an empty capture means.

    ``no snapshot was captured`` is what #656 printed, and it was read as a fact
    about the Job rather than as a fault in the test, so nobody investigated the
    capture itself. The wording has to name the test as the suspect.

    Only what the script actually prints is checked — the phrase is also quoted in
    a comment explaining why it went away, and matching that would forbid
    documenting the mistake.
    """
    fallback = script.split('if [ -s "${MIGRATE_SNAPSHOT_FILE}" ]', 1)[1]
    fallback = fallback.split("else", 1)[1].split("fi", 1)[0]
    printed = "\n".join(
        line for line in fallback.splitlines() if line.lstrip().startswith("echo")
    )

    assert "NOTHING CAPTURED" in printed
    assert "diagnostics" in printed, "the message must attribute the gap to the test"

    old_wording = [line for line in script.splitlines() if "no snapshot was captured" in line]
    assert not [line for line in old_wording if line.lstrip().startswith("echo")], (
        "the ambiguous wording is still printed"
    )


def test_watcher_captures_both_the_current_and_previous_container(script: str) -> None:
    """A failing Job restarts in place, so the crashed attempt holds the reason."""
    watcher = script.split("watch_migrate_logs() {", 1)[1].split("\n}", 1)[0]

    assert "--all-containers" in watcher
    assert "--previous" in watcher
    assert "job-name=migrate" in watcher, "the pod must be found by the Job's own label"
