"""The facts AGENTS.md and PROJECT_CONTEXT.md assert about CI triggers (#680).

Those docs claimed "a push to `dev` ... is not a CI event at all". It was wrong,
and it had been wrong since the trigger set was written. Three merges reached
`main` behind a CI row whose jobs were all `skipped` (#675, #676, #677).

This file does **not** change a trigger. It pins the three claims the corrected
docs now make, by reading the workflow YAML, so the description cannot silently
go stale the way it just did:

1. `synchronize` is a declared `pull_request` type — so advancing the head of an
   open `dev`→`main` PR **does** fire these workflows.
2. There is no `push` trigger — so the push is not itself the event.
3. The `ci` label gates *every* job, in a `pull_request`-scoped clause — so an
   unlabelled release PR yields a run that verified nothing.

(3) is the one with teeth. The docs now say **skipped is not passed**, which is
only a safe reading while the gate sits in each job's `if:`. If a job ever loses
its gate it runs unconditionally, and "a merge that shows green was verified"
becomes wrong in the direction that hides work — #638's exact failure, where
`exit-code: "1"` had never blocked anything.

Deliberately **not** asserted here: that the label gate is *desirable*. It is a
deliberate trade for Actions minutes (see `ci.yml`'s header). These tests only
pin what is, so a deliberate change fails loudly and gets a doc update, rather
than passing quietly and leaving three files asserting something false.
"""

import re
from functools import cache
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ["ci.yml", "infra.yml"]

#: The label the docs name as the gate on `dev`→`main` PRs.
GATE_LABEL = "ci"

#: The clause that gates a job on the *pull request* carrying that label.
#:
#: Matched whole rather than as a substring of `'ci'`, because the interesting
#: failure is a rewrite that checks only `github.event.label.name` (the event that
#: *added* the label) and drops the PR's own labels — which would let an unlabelled
#: release PR through while still containing the letters `ci`.
GATE_CLAUSE = f"contains(github.event.pull_request.labels.*.name, '{GATE_LABEL}')"

#: Docs that state the triggers, or restate the workflow's own header comment.
DOC_PATHS = [
    "AGENTS.md",
    "PROJECT_CONTEXT.md",
    ".github/workflows/infra.yml",
]

#: Fragments of the stale claim, so a re-wrap under a different line break cannot
#: reintroduce it unnoticed.
STALE_CLAIMS = ["not a CI event", "triggers neither", "never on a `dev` push"]

@cache
def _load(name: str) -> dict:
    return yaml.safe_load((REPO_ROOT / ".github/workflows" / name).read_text())


#: Every (workflow, job) pair, so a job added later is covered without editing
#: here — the two files have different job sets and both are enumerated.
JOBS = tuple((name, job) for name in WORKFLOWS for job in _load(name)["jobs"])


def _on(workflow: dict) -> dict:
    """The `on:` block. PyYAML parses a bare `on` key as the boolean True."""
    return workflow[True] if True in workflow else workflow["on"]


@pytest.fixture(scope="module", params=WORKFLOWS)
def workflow(request) -> dict:
    return _load(request.param)


class TestNoPushTrigger:
    """A push to `dev` is not itself the event — it arrives via `synchronize`."""

    def test_push_is_not_a_trigger(self, workflow):
        assert "push" not in _on(workflow), (
            "a `push` trigger was added. The corrected docs (#680) explain that a `dev` "
            "push reaches these workflows through an open dev→main PR's `synchronize` "
            "event; a push trigger would make that explanation incomplete"
        )

    def test_synchronize_is_a_declared_pull_request_type(self, workflow):
        types = _on(workflow)["pull_request"]["types"]
        assert "synchronize" in types, (
            f"pull_request types are {types}. Without `synchronize`, a push to `dev` could "
            "not reach this workflow at all, and the corrected CI-triggers docs (#680) "
            "would be asserting something false"
        )


class TestReleasePrIsTheTrigger:
    """The PR must target `main` — that is what makes it a release PR."""

    def test_base_branch_is_main(self, workflow):
        branches = _on(workflow)["pull_request"]["branches"]
        assert branches == ["main"], (
            f"pull_request base branches are {branches}; the docs describe a dev→main "
            "release PR as the only PR path that runs (#680)"
        )


class TestLabelGateCoversEveryJob:
    """Skipped-is-not-passed is only true while the gate is per-job."""

    @pytest.mark.parametrize(("name", "job"), sorted(set(JOBS)))
    def test_job_gate_depends_on_the_pr_carrying_the_label(self, name, job):
        condition = _load(name)["jobs"][job].get("if")
        assert condition, f"{name} job {job!r} has no `if:` at all, so it always runs"
        assert GATE_CLAUSE in condition, (
            f"{name} job {job!r} does not gate on {GATE_CLAUSE!r} (it has {condition!r}). "
            "An unlabelled dev→main PR would then run this job, so the documented "
            "'triggered but verifies nothing' outcome (#680) would no longer hold"
        )


class TestDocsMatchTheWorkflows:
    """The corrected prose is present, so a re-introduction is caught."""

    @pytest.mark.parametrize("path", ["AGENTS.md", "PROJECT_CONTEXT.md"])
    def test_no_doc_repeats_the_stale_claim(self, path):
        text = (REPO_ROOT / path).read_text()
        for claim in STALE_CLAIMS:
            assert claim not in text, (
                f"{path} still asserts {claim!r}, which #680 established is false: a push "
                "to `dev` reaches both workflows through an open dev→main PR"
            )

    @pytest.mark.parametrize("path", DOC_PATHS)
    def test_doc_explains_how_a_dev_push_reaches_the_workflows(self, path):
        text = (REPO_ROOT / path).read_text()
        assert re.search(r"(push to .dev.|advances the head)", text), (
            f"{path} no longer explains how a `dev` push reaches the workflows, so a reader "
            "cannot tell a run that fired from one that did not (#680)"
        )

    @pytest.mark.parametrize("path", DOC_PATHS)
    def test_doc_names_the_gate_label(self, path):
        assert GATE_LABEL in (REPO_ROOT / path).read_text(), (
            f"{path} does not name the `{GATE_LABEL}` label that actually gates the release PR"
        )
