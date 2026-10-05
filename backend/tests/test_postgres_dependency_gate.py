"""Every workload that runs the app image must gate on Postgres being ready (#654).

The migrate Job was the one workload that connected to the database and the only
one with nothing ordering it against Postgres. ``alembic upgrade head`` opens a
connection on its first instruction, so on a fresh ``kubectl apply`` it raced the
Postgres StatefulSet through its image pull and PVC init. The connection was
refused, ``backoffLimit: 3`` was exhausted, the Job controller deleted the pod,
and the Job never reached a ``Complete`` condition — which is what the backend's
``wait-for-migrate`` waits for. The visible symptom was a 300s timeout on a
migration that had never really run.

The gate already existed twice, in the backend and worker Deployments. Nothing
required a *third* workload to use it, which is why the one that most needs it
did not: it is the absence of a rule, not a typo.

So these tests pin the rule instead. Kustomize, Helm and kubeconform are not
runnable in the backend test environment, so a static read is what catches the
omission in CI for the Kustomize side.
"""

from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BASE = REPO_ROOT / "infra/k8s/base"
HELM_TEMPLATES = REPO_ROOT / "infra/helm/ai-platform/templates"

GATE_NAME = "wait-for-postgres"
#: Images that open a database connection on startup, so they cannot race it.
APP_IMAGES = ("backend", "worker")
WORKLOAD_KINDS = ("Deployment", "StatefulSet", "Job")


def _base_documents() -> list[dict]:
    docs: list[dict] = []
    for path in sorted(BASE.glob("*.yaml")):
        docs.extend(yaml.safe_load_all(path.read_text()))
    return [d for d in docs if isinstance(d, dict)]


def _pod_spec(doc: dict) -> dict | None:
    """The pod spec of a workload document, or None if it is not one."""
    if doc.get("kind") not in WORKLOAD_KINDS:
        return None
    return doc.get("spec", {}).get("template", {}).get("spec")


def _app_workloads() -> list[tuple[str, dict]]:
    """Every base workload whose *main* containers run an app image.

    Init containers are excluded deliberately: the gate itself runs busybox, so
    including them would make every workload look like an app workload.
    """
    found = []
    for doc in _base_documents():
        pod = _pod_spec(doc)
        if pod is None:
            continue
        images = [c.get("image", "") for c in pod.get("containers", [])]
        if any(any(app in image for app in APP_IMAGES) for image in images):
            found.append((doc["metadata"]["name"], pod))
    return found


def _gates() -> dict[str, list[dict]]:
    """Every wait-for-postgres init container in the base, keyed by workload."""
    gates: dict[str, list[dict]] = {}
    for name, pod in _app_workloads():
        found = [c for c in pod.get("initContainers", []) if c.get("name") == GATE_NAME]
        if found:
            gates[name] = found
    return gates


def test_app_workloads_are_discovered():
    """Guard against the discovery below silently matching nothing.

    A rule that finds no workloads passes every assertion in this file, which is
    the failure mode a test suite can least afford.
    """
    names = {name for name, _ in _app_workloads()}
    assert {"backend", "worker", "migrate"} <= names, (
        f"expected the backend, worker and migrate workloads, found {sorted(names)}"
    )


@pytest.mark.parametrize("name", ["backend", "worker", "migrate"])
def test_app_workload_waits_for_postgres(name):
    """The invariant itself: running an app image means depending on Postgres."""
    pods = dict(_app_workloads())
    assert name in pods, f"{name} no longer runs an app image; update this test"
    gate = [c for c in pods[name].get("initContainers", []) if c.get("name") == GATE_NAME]
    assert gate, (
        f"workload {name!r} runs an app image but has no {GATE_NAME!r} init "
        f"container, so it can start before Postgres accepts connections"
    )


def test_the_gate_has_exactly_one_spelling():
    """Identical everywhere, so a fix to the gate is a fix rather than a choice.

    Three copies of the same loop drift: someone hardens one, or changes the
    sleep interval, and there is no longer a single thing to reason about.
    """
    gates = _gates()
    assert len(gates) == 3, f"expected three gated workloads, found {sorted(gates)}"
    distinct = {yaml.safe_dump(v[0], sort_keys=True) for v in gates.values()}
    assert len(distinct) == 1, (
        "wait-for-postgres is spelled differently across "
        f"{sorted(gates)}: {sorted(distinct)}"
    )


@pytest.mark.parametrize("name", ["backend", "worker", "migrate"])
def test_the_gate_is_hardened(name):
    """The gate runs as an unprivileged uid with no capabilities.

    It waits on a network port, so it needs nothing at all — an init container
    that runs as root to do `nc` is a root container for no reason, and these are
    inherited by staging and production.
    """
    gate = _gates()[name][0]
    ctx = gate.get("securityContext", {})
    assert ctx.get("runAsNonRoot") is True
    assert isinstance(ctx.get("runAsUser"), int), (
        f"runAsUser must be an explicit numeric uid, got {ctx.get('runAsUser')!r}"
    )
    assert ctx.get("allowPrivilegeEscalation") is False
    assert ctx.get("capabilities", {}).get("drop") == ["ALL"]


class TestHelmChartMatchesTheBase:
    """The chart is a second install path, and it had the same omission."""

    @pytest.mark.parametrize("template", ["backend.yaml", "worker.yaml", "migrate.yaml"])
    def test_chart_workload_has_the_gate(self, template):
        text = (HELM_TEMPLATES / template).read_text()
        assert f"- name: {GATE_NAME}" in text, (
            f"infra/helm/ai-platform/templates/{template} has no "
            f"{GATE_NAME!r} init container"
        )

    def test_the_gate_is_defined_once_per_workload(self):
        """The chart spells the gate out per template, so an extra copy would be
        a second init container with the same name — rejected by the API server
        only at apply time, which is the Kind smoke test's job to find."""
        for template in ("backend.yaml", "worker.yaml", "migrate.yaml"):
            text = (HELM_TEMPLATES / template).read_text()
            assert text.count(f"- name: {GATE_NAME}") == 1, (
                f"{template} declares {GATE_NAME} "
                f"{text.count(f'- name: {GATE_NAME}')} times"
            )
