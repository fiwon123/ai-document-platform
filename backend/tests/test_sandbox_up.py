"""``make shell`` / ``make opencode`` must not rebuild a running sandbox.

The exec-style entry points used to run ``docker compose up -d --build dev
worker`` unconditionally. ``--build`` re-runs the image build even when the
containers are already up, so calling ``make shell`` right after ``make dev-up``
or ``make dev-restart`` kicked off a *second* build that raced the live stack
(and could clobber a running ``make opencode`` session). Users hit this often
enough that the sandbox entry points now go through
``scripts/ensure-sandbox-running.sh``, which builds only when the sandbox was
never initialized.

The behavioural test below is the real guard: it puts a fake ``docker`` on PATH
that records the arguments it is called with, then asserts *which* commands the
helper issues for each container state. A grep for ``--build`` would only prove
the string is absent; this proves the actual behaviour, including the direction
that matters — that a running stack is left completely untouched.
"""

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HELPER = REPO_ROOT / "scripts" / "ensure-sandbox-running.sh"
MAKEFILE = REPO_ROOT / "Makefile"
OPEN_IN_SANDBOX = REPO_ROOT / "scripts" / "open-in-sandbox.sh"

# A fake `docker` that records every `compose up` it is asked to perform and
# answers `compose ps` from canned state, so the branch taken by the helper can
# be observed without a Docker daemon.
FAKE_DOCKER = """\
#!/bin/bash
log="$FAKE_LOG"
if [ "${1:-}" = "ps" ]; then
    fmt=""; svc=""
    for a in "$@"; do
        case "$a" in
            '{{.State}}')  fmt=state ;;
            '{{.Health}}') fmt=health ;;
            ps|-*)         ;;
            *)             svc="$a" ;;
        esac
    done
    case "$fmt" in
        state)  printf '%s\\n' "${FAKE_STATE:-}" ;;
        health) printf '%s\\n' "${FAKE_HEALTH:-}" ;;
    esac
    exit 0
fi
if [ "${1:-}" = "up" ]; then
    printf '%s\\n' "$*" >>"$log"
    exit 0
fi
exit 0
"""


@pytest.fixture
def run_helper(tmp_path):
    """Run the helper against a fake docker; return the recorded `up` calls."""

    def _run(state="", health="", **extra_env):
        fake = tmp_path / "fake-docker"
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o755)
        log = tmp_path / "calls.log"
        # One log per invocation: a caller that loops over states must not see
        # the previous run's calls.
        log.unlink(missing_ok=True)

        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{tmp_path}{os.pathsep}{env['PATH']}",
                "FAKE_LOG": str(log),
                "FAKE_STATE": state,
                "FAKE_HEALTH": health,
                # A single executable path (no spaces) so the helper's
                # unquoted $COMPOSE word-splits to exactly this program.
                "COMPOSE": str(fake),
                # Keep a mismatched expectation from hanging the suite.
                "SANDBOX_WAIT_TIMEOUT": "5",
            }
        )
        env.update(extra_env)

        # Absolute interpreter path: avoids S607 (partial executable path) and
        # does not depend on the caller's PATH.
        result = subprocess.run(  # noqa: S603
            ["/bin/bash", str(HELPER)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        calls = log.read_text().splitlines() if log.exists() else []
        return result, calls

    return _run


def make_target_recipe(target: str) -> str:
    """The recipe lines of one Makefile target."""
    text = MAKEFILE.read_text()
    out, capturing = [], False
    for line in text.splitlines():
        if line.startswith(f"{target}:"):
            capturing = True
            continue
        if capturing:
            if line.startswith("\t"):
                out.append(line)
            else:
                break
    return "\n".join(out)


# --- the fix itself: what the helper does per state ------------------------


def test_running_sandbox_is_left_untouched(run_helper):
    """The regression: a healthy stack must not be rebuilt or even restarted."""
    result, calls = run_helper(state="running", health="healthy")

    assert result.returncode == 0, result.stderr
    assert calls == [], (
        f"a running sandbox must not be re-created, but the helper ran: {calls}"
    )
    assert "skipping image build" in result.stderr


def test_never_initialized_sandbox_builds(run_helper):
    """The one case that legitimately needs a build: no container at all."""
    result, calls = run_helper(state="")

    assert result.returncode == 0, result.stderr
    assert len(calls) == 1, f"expected exactly one `up`, got: {calls}"
    assert "--build" in calls[0], (
        f"a sandbox that was never initialized must build, got: {calls[0]}"
    )


@pytest.mark.parametrize("state", ["exited", "created", "restarting", "paused"])
def test_existing_container_restarts_without_rebuilding(run_helper, state):
    """An existing image is enough to come back up — no rebuild required."""
    result, calls = run_helper(state=state, health="healthy")

    assert result.returncode == 0, result.stderr
    assert len(calls) == 1, f"expected exactly one `up`, got: {calls}"
    assert "--build" not in calls[0], (
        f"'{state}' has a usable image and must not be rebuilt, got: {calls[0]}"
    )


def test_building_is_the_only_ever_use_of_the_build_flag(run_helper):
    """Across every state the helper knows, only 'not initialized' builds."""
    states = ["", "created", "exited", "restarting", "paused", "running", "wat"]

    for state in states:
        result, calls = run_helper(state=state, health="healthy")
        assert result.returncode == 0, (state, result.stderr)
        built = [c for c in calls if "--build" in c]
        if state == "":
            assert built, f"{state!r} must build"
        else:
            assert not built, f"{state!r} must not rebuild, but ran: {built}"


def test_waits_for_readiness_before_returning(run_helper):
    """`exec` on a still-booting container is the bug this whole change avoids."""
    result, _ = run_helper(
        state="running", health="healthy", SANDBOX_WAIT_TIMEOUT="5"
    )

    assert result.returncode == 0, result.stderr
    assert "ERROR" not in result.stderr


# --- wiring: the entry points actually use the helper -----------------------


@pytest.mark.parametrize("target", ["dev-exec", "opencode"])
def test_exec_targets_do_not_build_unconditionally(target):
    recipe = make_target_recipe(target)

    assert "$(SANDBOX_UP)" in recipe, (
        f"`make {target}` must go through $(SANDBOX_UP) so it can skip the build "
        f"when the sandbox is already up; got:\n{recipe}"
    )
    assert "--build" not in recipe, (
        f"`make {target}` must not pass --build itself; that reintroduces the "
        f"duplicate build. Got:\n{recipe}"
    )


def test_open_in_sandbox_delegates_instead_of_building():
    script = OPEN_IN_SANDBOX.read_text()
    recipes = [
        line for line in script.splitlines()
        if "compose up" in line and not line.lstrip().startswith("#")
    ]

    assert not recipes, (
        "open-in-sandbox.sh must not run `docker compose up` itself; it should "
        f"delegate to ensure-sandbox-running.sh. Found: {recipes}"
    )
    assert "ensure-sandbox-running.sh" in script


@pytest.mark.parametrize("target", ["dev-up", "dev-restart"])
def test_explicit_restart_targets_still_build(target):
    """The other direction: a deliberate restart must keep rebuilding.

    This is the escape hatch for a changed Dockerfile/pyproject.toml, so the
    "skip the build" optimisation must not quietly disable it.
    """
    assert "--build" in make_target_recipe(target)


def test_helper_is_executable():
    assert os.access(HELPER, os.X_OK), f"{HELPER} must be executable"
