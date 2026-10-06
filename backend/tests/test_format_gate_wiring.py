"""The frontend formatting gate is *wired*, not merely present (#690).

`frontend/package.json` shipped `"format:check": "oxfmt --check"` while **156 of
181** frontend files failed it, because nothing called it: not CI, not
`make check`, and not `make format` (which only ran `ruff format` on the
backend). A script with no caller is a check that cannot fire — the same defect
class as #638 (a step that was skipped, not passed), #680 (a label gate that let
three merges through unverified) and #682 (`SELECT 1` succeeding against an
empty database).

So wiring it in is only half the change. This file pins the wiring itself, by
reading the two files that call the check, so a later refactor cannot quietly
drop the step and leave the tree free to drift again with every run green:

1. `ci.yml`'s `frontend-lint` job runs `npm run format:check`.
2. `make check` depends on the `format-check` target.
3. `format-check` and `format` really do invoke the frontend scripts.
4. `frontend/package.json` still exposes `format:check` for them to call.

Assertions are made against **whole command strings and whole prerequisite
tokens**, never substrings — `npm run format` is a substring of `npm run
format:check`, so an `in` check on the former cannot distinguish the two.

Deliberately **not** asserted: that the backend is ruff-formatted.
`ruff format --check src/` fails on 43 files today and is ungated on purpose
(see #690) — pinning the frontend gate must not smuggle in a backend gate that
nothing has run yet. If that changes, it gets its own issue and its own test.
"""

import json
import re
from functools import cache
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

CI_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yml"
MAKEFILE_PATH = REPO_ROOT / "Makefile"
PACKAGE_JSON_PATH = REPO_ROOT / "frontend" / "package.json"

#: Docs that spell out what `make check` runs in a trailing comment.
#:
#: Kept in step with the gate on purpose: a doc that lists only lint, tests and
#: build becomes false the moment the gate gains a step — which is what happened
#: to the CI-trigger claims in #680, where three files asserted something the
#: workflows had not done for some time.
CHECK_DOC_PATHS = ["AGENTS.md", "DEVELOPMENT.md", "CONTRIBUTING.md"]

#: The job that lints the frontend, and therefore the job that owns the check.
CI_JOB = "frontend-lint"


@cache
def _ci() -> dict:
    return yaml.safe_load(CI_PATH.read_text())


@cache
def _package_json() -> dict:
    return json.loads(PACKAGE_JSON_PATH.read_text())


def _target(name: str) -> tuple[list[str], str]:
    """Return ``(prerequisites, recipe)`` for one top-level Make target.

    The block runs from ``name:`` to the next line that starts at column 0 with
    a non-whitespace character — recipe lines are indented with a tab, so they
    do not terminate the block, and so a target cannot accidentally absorb the
    one below it.
    """
    text = MAKEFILE_PATH.read_text()
    match = re.search(
        rf"^{re.escape(name)}:.*?(?=^\S|\Z)",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert match, f"no `{name}:` target in the Makefile"

    block = match.group(0)
    head, _, body = block.partition("\n")

    # Drop the `## help` comment before splitting, or its prose becomes a
    # "prerequisite".
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


class TestCiRunsFormatCheck:
    """CI must be able to fail on an unformatted frontend file."""

    def test_frontend_lint_job_runs_the_format_check(self):
        commands = _run_commands(CI_JOB)
        assert "npm run format:check" in commands, (
            f"the {CI_JOB!r} job runs {commands!r} and none of them is "
            "'npm run format:check'. The gate is gone from CI, which is the exact "
            "state #690 fixed: a check nothing calls, while the tree drifts"
        )

    def test_the_format_check_runs_after_the_lint_it_sits_beside(self):
        commands = _run_commands(CI_JOB)
        assert "npm run lint" in commands, (
            f"the {CI_JOB!r} job no longer lints either ({commands!r}); this file "
            "assumes both checks live in one job"
        )
        # Assert presence first: `list.index` on a missing value raises ValueError,
        # which would report "x is not in list" instead of saying the gate is gone.
        assert "npm run format:check" in commands, (
            f"the {CI_JOB!r} job runs {commands!r} with no 'npm run format:check'"
        )
        assert commands.index("npm run format:check") > commands.index("npm run lint"), (
            "format:check was moved before the lint step. Order is not load-bearing "
            "for correctness, but changing it deliberately should be a visible edit "
            "to this test rather than a silent drift"
        )


class TestMakeGateIncludesFormatCheck:
    """`make check` is the local gate, so the check has to be one of its steps."""

    def test_check_depends_on_format_check(self):
        prerequisites, _ = _target("check")
        assert "format-check" in prerequisites, (
            f"make check runs {prerequisites!r} and 'format-check' is not among them. "
            "The local gate can no longer fail on formatting, which is how "
            "156 of 181 files went unformatted unnoticed (#690)"
        )

    def test_check_still_runs_lint_test_and_build(self):
        prerequisites, _ = _target("check")
        for required in ("lint", "test", "build"):
            assert required in prerequisites, (
                f"make check no longer runs {required!r} — it runs {prerequisites!r}"
            )

    def test_format_check_target_calls_the_frontend_script(self):
        _, recipe = _target("format-check")
        assert "npm run format:check" in recipe, (
            f"the format-check recipe is {recipe!r}; it must call "
            "'npm run format:check', which is the command that can actually fail"
        )


class TestFormatTargetsCoverTheFrontend:
    """`make format` used to be backend-only, so there was no documented way to
    reach the state the check demanded."""

    def test_format_target_formats_the_frontend(self):
        _, recipe = _target("format")
        assert re.search(r"npm run format(?!:)", recipe), (
            f"the format recipe is {recipe!r}; it must run 'npm run format' "
            "(oxfmt) for the frontend, not only 'ruff format' for the backend"
        )

    def test_format_target_still_formats_the_backend(self):
        _, recipe = _target("format")
        assert "ruff format" in recipe, (
            f"the format recipe is {recipe!r}; the backend half was dropped"
        )

    def test_package_json_still_exposes_format_check(self):
        scripts = _package_json()["scripts"]
        assert scripts.get("format:check") == "oxfmt --check", (
            f"frontend/package.json format:check is {scripts.get('format:check')!r}; "
            "both CI and make check call it by name"
        )

    def test_package_json_still_exposes_format(self):
        scripts = _package_json()["scripts"]
        assert scripts.get("format") == "oxfmt", (
            f"frontend/package.json format is {scripts.get('format')!r}; "
            "'make format' calls it by name"
        )


class TestDocsDescribeTheGateAccurately:
    """A doc listing lint/tests/build for `make check` is false once the gate
    gains a step. #680's stale CI claims were exactly that."""

    @pytest.mark.parametrize("path", CHECK_DOC_PATHS)
    def test_a_make_check_comment_that_names_lint_also_names_format(self, path):
        for line in (REPO_ROOT / path).read_text().splitlines():
            if "make check" not in line or "#" not in line:
                continue
            # Only composition descriptions — a prose line like "run `make check`
            # before every push" carries no component list to keep in step.
            if "lint" not in line:
                continue
            assert "format" in line, (
                f"{path}: {line.strip()!r} describes what `make check` runs but omits "
                "`format`, while the gate depends on `format-check` (#690)"
            )
