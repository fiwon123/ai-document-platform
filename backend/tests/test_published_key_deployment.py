"""No committed signing key may escape the startup guard (#524).

``app.config.ensure_secret_key_acceptable`` refuses specific values. That check is
only as good as the list of values it knows, and the list is maintained by hand
while the keys themselves live in five unrelated config files. So these tests
read those files and assert, in the direction that matters, that **every** signing
key this repository publishes is one the guard refuses.

They also pin the environments that are *meant* to run with a published key. The
dev sandbox and the Kind overlay acknowledge it explicitly; staging and
production must not, because both inherit the same base Secret, and an
acknowledgement in either would be a live deployment opting into forgery.

Kustomize and kubeconform cannot be run in the backend test environment, so this
static read is what catches a wiring mistake in CI for the kustomize side.
"""

import base64
import re
from pathlib import Path

import pytest
import yaml

from app.config import ALLOW_PLACEHOLDER_ENV_VAR, PUBLISHED_SECRET_KEYS

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_PATH = REPO_ROOT / "docker-compose.yaml"
BASE_SECRET_PATH = REPO_ROOT / "infra/k8s/base/secret.yaml"
HELM_VALUES_PATH = REPO_ROOT / "infra/helm/ai-platform/values.yaml"
ENV_EXAMPLE_PATH = REPO_ROOT / "backend/.env.example"
OVERLAYS = REPO_ROOT / "infra/k8s/overlays"


def _compose_services() -> dict:
    return yaml.safe_load(COMPOSE_PATH.read_text())["services"]


def _overlay_patches(name: str) -> list[str]:
    """Patch bodies of one overlay, comments stripped by virtue of being parsed."""
    doc = yaml.safe_load((OVERLAYS / name / "kustomization.yaml").read_text())
    return [p.get("patch", "") for p in doc.get("patches", [])]


class TestAcknowledgementWiring:
    """The dev environments may run with a published key; nothing else may."""

    @pytest.mark.parametrize("service", ["dev", "worker"])
    def test_compose_dev_services_acknowledge_the_published_key(self, service):
        env = _compose_services()[service]["environment"]
        assert env.get(ALLOW_PLACEHOLDER_ENV_VAR) == f"${{{ALLOW_PLACEHOLDER_ENV_VAR}:-1}}"

    @pytest.mark.parametrize("deployment", ["backend", "worker"])
    def test_kind_dev_overlay_acknowledges_the_published_key(self, deployment):
        bodies = _overlay_patches("dev")
        matching = [
            body
            for body in bodies
            if deployment in body and ALLOW_PLACEHOLDER_ENV_VAR in body
        ]
        assert matching, f"dev overlay does not patch {deployment} with the opt-in"

    @pytest.mark.parametrize("overlay", ["staging", "production"])
    def test_deployed_overlays_do_not_acknowledge_it(self, overlay):
        """Both inherit infra/k8s/base/secret.yaml. An acknowledgement here would
        be a real deployment running with a forgeable key."""
        for body in _overlay_patches(overlay):
            assert ALLOW_PLACEHOLDER_ENV_VAR not in body, (
                f"the {overlay} overlay acknowledges the published signing key"
            )

    def test_the_flag_is_not_baked_into_the_shared_base(self):
        """The base is inherited by every environment, so the opt-in cannot live
        there even once, or staging inherits it too."""
        assert ALLOW_PLACEHOLDER_ENV_VAR not in BASE_SECRET_PATH.read_text()
        assert ALLOW_PLACEHOLDER_ENV_VAR not in yaml.safe_load(
            (OVERLAYS / ".." / "base" / "configmap.yaml").read_text()
        ).get("data", {})


class TestEveryPublishedKeyIsKnownToTheGuard:
    """The direction that catches a *newly* committed key."""

    def test_compose_defaults_are_known(self):
        found = re.findall(
            r"\$\{SECRET_KEY:-([^}]+)\}", COMPOSE_PATH.read_text()
        )
        assert found, "compose no longer assigns SECRET_KEY; update this test"
        for value in found:
            assert value in PUBLISHED_SECRET_KEYS, (
                f"docker-compose.yaml publishes a signing key the guard does not "
                f"refuse: {value!r}"
            )

    def test_base_secret_value_is_known(self):
        """Decoded, because the base stores keys base64-encoded — an encoded
        published key is still a published key."""
        data = yaml.safe_load(BASE_SECRET_PATH.read_text())["data"]
        decoded = base64.b64decode(data["SECRET_KEY"]).decode()
        assert decoded in PUBLISHED_SECRET_KEYS, (
            f"infra/k8s/base/secret.yaml publishes a signing key the guard does "
            f"not refuse: {decoded!r}"
        )

    def test_env_example_is_known(self):
        match = re.search(
            r"^SECRET_KEY=(.*)$", ENV_EXAMPLE_PATH.read_text(), re.MULTILINE
        )
        assert match, ".env.example no longer sets SECRET_KEY; update this test"
        assert match.group(1) in PUBLISHED_SECRET_KEYS

    def test_helm_default_is_known(self):
        """The chart publishes a *different* default from compose, which is
        exactly why the guard keeps a list rather than one constant."""
        values = yaml.safe_load(HELM_VALUES_PATH.read_text())
        assert values["secrets"]["jwtSecretKey"] in PUBLISHED_SECRET_KEYS

    def test_guard_refuses_every_key_found_anywhere(self):
        """Belt and braces: nothing published in the repo passes the check."""
        for published in PUBLISHED_SECRET_KEYS:
            with pytest.raises(RuntimeError, match="value committed to this repository"):
                from app.config import ensure_secret_key_acceptable

                ensure_secret_key_acceptable(published)
