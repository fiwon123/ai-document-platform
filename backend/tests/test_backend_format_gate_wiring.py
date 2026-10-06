"""The backend formatting gate is *wired*, not merely present (#692).

Until #692 the backend shipped with `ruff format --check src/` failing on 43
files and ungated on every path: not in CI (`backend-check` runs only
`ruff check`, lint), not in `make check` (`format-check` called only the
frontend oxfmt script), and the Makefile's own comment said so ("Backend ruff
format is not yet enforced"). A check with no caller cannot fire — the same
defect class as #638/#680/#682, and the backend twin of the frontend gate
fixed in #690/#691.

Wiring it in is only half the change. This file pins the wiring itself, by
reading the two files that call the check, so a later refactor cannot quietly
drop the step and let the tree drift again with every run green:

1. `ci.yml`'s `backend-check` job runs `uv run ruff format --check src/`.
2. `make check` depends on the `format-check` target.
3. `format-check` really invokes the backend ruff format check.
4. `make format` still reaches the formatted state the check demands.

Assertions are made against **whole command strings and whole prerequisite
tokens**, never substrings — and presence is asserted before it is indexed,
so a removed step reports "the gate is gone" instead of raising ValueError.
"""

import re
from functools import cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

CI_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yml"
MAKEFILE_PATH = REPO_ROOT / "Makefile"

#: The job that lints the backend, and therefore the job that owns the check.
CI_JOB = "backend-check"

#: The exact command that can fail. Whole-string assertions only.
FORMAT_CHECK = "uv run ruff format --check src/"


@cache
def _ci() -> dict:
    return yaml.safe_load(CI_PATH.read_text())


def _target(name: str) -> tuple[list[str], str]:
    """Return ``(prerequisites, recipe)`` for one top-level Make target."""
    text = MAKEFILE_PATH.read_text()
    match = re.search(
        rf"^{re.escape(name)}:.*?(?=^\S|\Z)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert match, f"no `{name}:` target in the Makefile"

    block = match.group(0)
    head, _, body = block.partition("\n")
    spec = head.split("##", 1)[0]
    prerequisites = spec.split(":", 1)[1].split()
    recipe = "\n".join(line for line in body.splitlines() if line.startswith("\t"))
    return prerequisites, recipe


def _run_commands(job: str) -> list[str]:
    """Every ``run:`` value in a CI job, in order."""
    workflow = _ci()
    assert job in workflow["jobs"], (
        f"{CI_PATH.name} has no {job!r} job — if it was renamed, the "
        "formatting gate moved with it and this test must follow"
    )
    return [
        step["run"]
        for step in workflow["jobs"][job]["steps"]
        if isinstance(step.get("run"), str)
    ]


class TestCiRunsBackendFormatCheck:
    """CI must be able to fail on an unformatted backend file."""

    def test_backend_check_job_runs_the_format_check(self):
        commands = _run_commands(CI_JOB)
        assert FORMAT_CHECK in commands, (
            f"the {CI_JOB!r} job runs {commands!r} and none of them is "
            f"{FORMAT_CHECK!r}. The gate is gone from CI, which is the exact "
            "state #692 fixed: a check nothing calls, while the tree drifts"
        )

    def test_the_format_check_runs_after_the_lint_it_sits_beside(self):
        commands = _run_commands(CI_JOB)
        assert "uv run ruff check src/" in commands, (
            f"the {CI_JOB!r} job no longer lints either ({commands!r}); this file "
            "assumes both checks live in one job"
        )
        assert FORMAT_CHECK in commands, (
            f"the {CI_JOB!r} job runs {commands!r} with no {FORMAT_CHECK!r}"
        )
        assert commands.index(FORMAT_CHECK) > commands.index("uv run ruff check src/"), (
            "format check was moved before the lint step. Order is not load-bearing "
            "for correctness, but changing it deliberately should be a visible edit "
            "to this test rather than a silent drift"
        )


class TestMakeGateIncludesBackendFormatCheck:
    """`make check` is the local gate, so the check has to be one of its steps."""

    def test_check_depends_on_format_check(self):
        prerequisites, _ = _target("check")
        assert "format-check" in prerequisites, (
            f"make check runs {prerequisites!r} and 'format-check' is not among them. "
            "The local gate can no longer fail on formatting, which is how "
            "43 backend files went unformatted unnoticed (#692)"
        )

    def test_format_check_target_calls_the_backend_check(self):
        _, recipe = _target("format-check")
        assert FORMAT_CHECK in recipe, (
            f"the format-check recipe is {recipe!r}; it must call {FORMAT_CHECK!r}, "
            "the command that can actually fail"
        )

    def test_format_check_target_still_calls_the_frontend_check(self):
        _, recipe = _target("format-check")
        assert "npm run format:check" in recipe, (
            f"the format-check recipe is {recipe!r}; the frontend half was dropped "
            "(the two checks share one target by design, #690)"
        )


class TestFormatTargetReachesTheDemandedState:
    """`make format` must produce what `format --check` demands."""

    def test_format_target_formats_the_backend(self):
        _, recipe = _target("format")
        assert re.search(r"uv run ruff format(?! --check)", recipe), (
            f"the format recipe is {recipe!r}; it must run 'ruff format' (no --check) "
            "for the backend, or the check can never be satisfied"
        )