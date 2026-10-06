"""The uv.lock upgrade automation is wired, not merely present (#696).

Dependabot's `pip` ecosystem edits `backend/pyproject.toml` and never the
lockfile, so every backend PR it opens lands unmergeable until a human
regenerates `uv.lock` (measured across all 8 merges of the #695 batch). The
`uv-lock-upgrade` workflow is the mechanism that replaces that human, so its
shape is load-bearing:

1. It regenerates the lock *and* syncs/tests it with the CI service set — a
   PR that carries a broken lock must never be opened.
2. It opens the PR against `dev`, the integration branch, not the default.
3. It carries `contents: write` + `pull-requests: write` — without the first
   the regenerated lock can never reach a branch; without the second the PR
   cannot open.

This file reads the workflow and pins each of those properties, on whole
command strings and whole tokens, so a refactor that quietly breaks the
automation fails loudly here instead of going silent in the schedule.
"""

from functools import cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "uv-lock-upgrade.yml"

#: Spellings PyYAML's YAML 1.1 default would turn into booleans but GitHub
#: Actions reads as the literal words — `on:` is the workflow trigger key.
_ACTION_WORDS = {"on", "On", "ON", "off", "Off", "OFF"}


class _WorkflowLoader(yaml.SafeLoader):
    """SafeLoader that keeps `on`/`off` literal, like GitHub Actions does.

    yaml.safe_load implements YAML 1.1, where ``on`` is a boolean — the
    trigger key ``on:`` would arrive as ``True`` and ``workflow["on"]`` would
    KeyError. This subclass yields the literal word for those spellings and
    delegates everything else to the default constructor. ``add_constructor``
    copies the registry on first use, so the shared SafeLoader is untouched.
    """


def _construct_bool_literal(loader, node):
    if loader.construct_scalar(node) in _ACTION_WORDS:
        return loader.construct_scalar(node)
    return loader.construct_yaml_bool(node)


_WorkflowLoader.add_constructor("tag:yaml.org,2002:bool", _construct_bool_literal)


@cache
def _workflow() -> dict:
    return yaml.load(WORKFLOW_PATH.read_text(), Loader=_WorkflowLoader)


def _job_commands(job: str) -> list[str]:
    """Every ``run:`` value in one job, in order."""
    workflow = _workflow()
    assert job in workflow["jobs"], (
        f"{WORKFLOW_PATH.name} has no {job!r} job — if it was renamed, this "
        "test must follow"
    )
    return [
        step["run"]
        for step in workflow["jobs"][job]["steps"]
        if isinstance(step.get("run"), str)
    ]


def _job_text(job: str) -> str:
    """All ``run:`` values of one job joined — a multi-line step is a single
    list element, so substring assertions must run against the joined text."""
    return "\n".join(_job_commands(job))


class TestTriggerShape:
    """A schedule that never fires is a check that cannot fire (#638's shape)."""

    def test_runs_on_a_schedule(self):
        on = _workflow()["on"]
        assert isinstance(on.get("schedule"), list) and on["schedule"], (
            f"{WORKFLOW_PATH.name} has no `schedule:` trigger — the automation "
            "never runs without a human dispatching it"
        )

    def test_is_also_manually_dispatchable(self):
        on = _workflow()["on"]
        assert "workflow_dispatch" in on, (
            "no `workflow_dispatch` trigger — an operator cannot force a run "
            "when a dependency needs an immediate bump"
        )


class TestRegenerationAndVerification:
    """Regenerate *and* verify — a pre-locked-but-broken PR is the #683 shape."""

    def test_job_regenerates_the_lock(self):
        commands = _job_commands("upgrade")
        assert "uv lock --upgrade" in commands, (
            f"the upgrade job runs {commands!r} and none of them regenerates "
            "the lock ('uv lock --upgrade')"
        )

    def test_the_lock_step_runs_in_the_backend_directory(self):
        workflow = _workflow()
        steps = workflow["jobs"]["upgrade"]["steps"]
        hit = next(
            (s for s in steps if s.get("run") == "uv lock --upgrade"), None
        )
        assert hit is not None, "no step runs 'uv lock --upgrade'"
        assert hit.get("working-directory") == "backend", (
            "the lock regeneration must run in backend/ — it regenerates "
            "backend/uv.lock, not a root lockfile"
        )

    def test_job_syncs_locked_and_runs_the_suite(self):
        text = _job_text("upgrade")
        assert "uv sync --locked" in text, (
            "the upgrade job never runs 'uv sync --locked' — the regenerated "
            "lock must be known installable before a PR opens"
        )
        assert "uv run pytest -q" in text, (
            "the upgrade job never runs 'uv run pytest -q'"
        )

    def test_verification_steps_are_gated_on_changes(self):
        """Without the Detect step, the verification runs on *every* scheduled
        run even when nothing changed — and its `if:` means it stays skipped."""
        steps = _workflow()["jobs"]["upgrade"]["steps"]
        detect = next((s for s in steps if s.get("id") == "diff"), None)
        assert detect is not None, (
            "no step has `id: diff` — the change-detection output that gates "
            "sync/test/commit/PR is gone"
        )
        run = detect["run"]
        assert "has_changes" in run and "$GITHUB_OUTPUT" in run, (
            f"the detect step ({run!r}) no longer reports has_changes"
        )


class TestOpensThePRCorrectly:
    """The PR is the deliverable; its target and labels are load-bearing."""

    def test_pr_opens_against_dev(self):
        pr_cmd = next(
            (c for c in _job_commands("upgrade") if "gh pr create" in c), None
        )
        assert pr_cmd is not None, "no step opens the PR"
        assert "--base dev" in pr_cmd, (
            f"gh pr create ({pr_cmd!r}) does not target `dev` — a PR against "
            "the default branch would bypass the integration branch (#693)"
        )

    def test_pr_carries_the_chore_label(self):
        pr_cmd = next(
            (c for c in _job_commands("upgrade") if "gh pr create" in c), None
        )
        assert pr_cmd is not None, "no step opens the PR"
        assert "--label chore" in pr_cmd, (
            "the automated PR must be labelled chore, or it is invisible to "
            "the label-gated CI trigger conventions"
        )

    def test_permissions_allow_push_and_pr(self):
        permissions = _workflow().get("permissions")
        assert permissions == {"contents": "write", "pull-requests": "write"}, (
            f"permissions are {permissions!r}; the job needs contents: write "
            "to push the regenerated lock and pull-requests: write to open "
            "the PR"
        )