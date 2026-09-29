"""The Infra workflow must not be able to publish `latest` from a feature branch (#544).

``build-images`` re-tags every image it pushes as the floating ``latest``, and both
``staging`` and ``production`` resolve ``latest`` with ArgoCD self-heal watching
them. So moving that tag *is* a production action.

The guard used to be ``github.event_name == 'workflow_dispatch' || ...``, which
admits a dispatch of **any** ref. Since ``workflow_dispatch`` runs against whichever
ref is selected in the dropdown, ``gh workflow run infra.yml --ref <feature>`` —
the natural way to "just check my infra change" — published unmerged code as
``latest`` and let ArgoCD roll both environments onto it. The safe action and the
dangerous one were the same command.

These tests read the workflow and pin two things:

* **Semantics.** The publishing jobs' conditions are *evaluated* over a table of
  event contexts, so the feature-branch dispatch has to actually evaluate false.
  Substring matching would only prove someone wrote ``refs/heads/main`` somewhere.
* **Blast radius.** ``packages: write`` is granted to the one job that pushes and
  to nothing else, so a job that merely validates cannot write to the registry even
  if its own condition is widened by mistake.

The escape hatch is deliberately kept: ``validate`` and the Kind ``smoke`` test
neither write to the registry nor resolve ``latest``, so they stay dispatchable from
any ref. A fix that made dispatch useless everywhere would trade a production hazard
for a lost capability.
"""

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/infra.yml"

#: Jobs that push to ghcr.io. Their conditions are ref-restricted.
PUBLISHING_JOBS = ["build-images", "scan-images"]

#: Jobs that are safe from any ref because they never touch the registry.
NON_PUBLISHING_JOBS = ["validate", "smoke"]


@pytest.fixture(scope="module")
def workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text())


# --- a small evaluator for the GitHub expressions these guards use ---------------


def _literal(value) -> str:
    return repr(value)


def _substitute(expr: str, ctx: dict) -> str:
    """Replace ``github.*`` paths with Python literals so the expression can be evaluated.

    Longest paths first, otherwise ``github.event.action`` is mangled by a shorter
    prefix. Unknown ``github.`` references are left in place and then rejected by
    :func:`_evaluate`, so an unsupported construct fails loudly instead of being
    silently mis-evaluated into a passing test.
    """
    resolved = {
        "github.event.pull_request.labels.*.name": list(ctx.get("labels", [])),
        "github.event.pull_request.base.ref": ctx.get("base_ref"),
        "github.event.label.name": ctx.get("label"),
        "github.event.action": ctx.get("action"),
        "github.event_name": ctx.get("event_name"),
        "github.ref": ctx.get("ref"),
    }
    for path, value in resolved.items():
        expr = expr.replace(path, f"__SENTINEL_{_literal(value)}__")
    return expr


def _contains(haystack, needle) -> bool:
    """GitHub's ``contains`` over a list of strings is exact membership.

    Modelled explicitly because the substring reading is the trap: a label named
    ``ci-docs`` must not satisfy a ``ci`` check.
    """
    if isinstance(haystack, (list, tuple)):
        return needle in haystack
    if isinstance(haystack, str):
        return needle in haystack
    return False


def _evaluate(expr: str, ctx: dict) -> bool:
    """Evaluate one GitHub Actions ``if:`` expression for a single event context."""
    py = _substitute(expr.strip(), ctx)
    unresolved = re.findall(r"github\.[A-Za-z_.]+", py)
    assert not unresolved, (
        f"expression uses context this evaluator does not model: {sorted(set(unresolved))}. "
        "Extend _substitute rather than letting it evaluate to something unintended."
    )

    py = py.replace("__SENTINEL_", "").replace("__", "")
    py = py.replace("&&", " and ").replace("||", " or ")
    py = re.sub(r"!(?!=)", " not ", py)
    py = re.sub(r"(?<![\w.])true\b", "True", py)
    py = re.sub(r"(?<![\w.])false\b", "False", py)
    return bool(eval(py, {"__builtins__": {}}, {"contains": _contains}))  # noqa: S307


def _condition(workflow: dict, job: str) -> str:
    return workflow["jobs"][job]["if"]


def _contexts() -> dict:
    """Event contexts, keyed by name, covering the cases that must differ."""
    main = "refs/heads/main"
    feature = "refs/heads/feat/544-guard"
    pr_ref = "refs/pull/1/merge"

    def dispatch(ref: str) -> dict:
        return {"event_name": "workflow_dispatch", "ref": ref, "labels": [], "action": None}

    def pr(labels: list[str], action: str = "synchronize", label: str | None = None) -> dict:
        return {
            "event_name": "pull_request",
            "ref": pr_ref,
            "labels": labels,
            "action": action,
            "label": label,
        }

    return {
        "dispatch from main": dispatch(main),
        "dispatch from a feature branch": dispatch(feature),
        "dispatch from a tag": dispatch("refs/tags/v1.0"),
        "ci-labelled PR, synchronise": pr(["ci"]),
        "ci label just added": pr(["ci"], action="labeled", label="ci"),
        "PR with no ci label": pr(["bug", "documentation"]),
        "PR labelled with a near-miss label": pr(["ci-docs"]),
        "push to dev": {
            "event_name": "push",
            "ref": "refs/heads/dev",
            "labels": [],
            "action": None,
        },
    }


#: A publishing job may run for exactly these.
PUBLISH_ALLOWED = {"dispatch from main", "ci-labelled PR, synchronise", "ci label just added"}


class TestPublishGuard:
    """A feature-branch dispatch must not reach the jobs that move `latest`."""

    @pytest.mark.parametrize("job", PUBLISHING_JOBS)
    @pytest.mark.parametrize("case", sorted(_contexts()))
    def test_publishing_jobs_run_only_where_publishing_is_intended(self, workflow, job, case):
        runs = _evaluate(_condition(workflow, job), _contexts()[case])
        assert runs is (case in PUBLISH_ALLOWED), (
            f"{job} would run for {case!r} = {runs}. "
            + (
                "A feature-branch dispatch publishes unmerged code as the floating "
                "`latest` that staging and production follow (#544)."
                if runs
                else "This is the release path and must keep working."
            )
        )

    @pytest.mark.parametrize("job", PUBLISHING_JOBS)
    def test_dispatch_clause_is_explicitly_restricted_to_main(self, workflow, job):
        """Structural backstop for the semantic table above."""
        condition = _condition(workflow, job)
        assert "refs/heads/main" in condition, f"{job} does not name the one ref allowed to publish"
        assert "workflow_dispatch" in condition, f"{job} should still document its dispatch path"

    @pytest.mark.parametrize("job", PUBLISHING_JOBS)
    def test_release_pr_path_is_preserved(self, workflow, job):
        """A guard that only allowed dispatch would silently stop the release publish."""
        condition = _condition(workflow, job)
        assert "pull_request" in condition and "labels" in condition


class TestWritePermissionScope:
    """Only the pushing job may hold the registry credential."""

    def test_workflow_level_does_not_grant_package_write(self, workflow):
        assert "write" not in (workflow.get("permissions") or {}).get("packages", "read"), (
            "workflow-level `packages: write` hands the registry credential to every "
            "job, including the read-only validation steps (#544)"
        )

    def test_only_build_images_can_write_packages(self, workflow):
        writers = [
            job
            for job, body in workflow["jobs"].items()
            if (body.get("permissions") or {}).get("packages") == "write"
        ]
        assert writers == ["build-images"], f"unexpected jobs can write to the registry: {writers}"

    def test_build_images_holds_the_write_scope(self, workflow):
        assert workflow["jobs"]["build-images"]["permissions"]["packages"] == "write"

    def test_scan_images_pulls_without_pushing(self, workflow):
        """It docker-pulls the SHA-tagged images Trivy scans, so read is enough."""
        assert workflow["jobs"]["scan-images"]["permissions"]["packages"] == "read"


class TestEscapeHatchPreserved:
    """Refusing to publish must not make dispatch useless for validating a branch."""

    @pytest.mark.parametrize("job", NON_PUBLISHING_JOBS)
    def test_non_publishing_jobs_still_run_from_a_feature_branch(self, workflow, job):
        runs = _evaluate(_condition(workflow, job), _contexts()["dispatch from a feature branch"])
        assert runs is True, (
            f"{job} no longer runs on a feature-branch dispatch, so the safe way to "
            "check an infra change in CI is gone (#544)"
        )

    @pytest.mark.parametrize("job", NON_PUBLISHING_JOBS)
    def test_non_publishing_jobs_hold_no_write_scope(self, workflow, job):
        scopes = workflow["jobs"][job].get("permissions") or {}
        assert scopes.get("packages", "read") != "write"
