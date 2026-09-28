"""The dev sandbox must be able to receive LLM provider config (#454).

``docker-compose.yaml`` used to declare the whole ``dev`` environment inline and
no provider variables at all, so ``OPENAI_API_KEY`` & friends were read by the
application but could not be set in the sandbox without hand-editing the compose
file. These tests pin the pass-through *and* the defaults it uses.

The defaults are the interesting half. ``load_dotenv()`` does not override real
environment variables, so a value passed by Compose wins over both
``backend/src/app/.env`` and the ``os.getenv`` fallback in the code. Passing
``${EMBEDDING_MODEL:-}`` would therefore not be "no value" — it would be an
empty model id sent to the embeddings API on every call. So each default here is
the application's own default, which makes "unset" mean in the sandbox exactly
what it means in the host-native loop.

``#486`` added the ``extra_hosts`` guards at the bottom: passing the *variables*
through is worthless if the container cannot resolve the hostname the
documentation tells operators to point them at.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

COMPOSE_PATH = Path(__file__).resolve().parents[2] / "docker-compose.yaml"

# Every provider variable the application reads. Both the dev service (uvicorn)
# and the worker (embeddings) need them; the worker is the one that calls the
# embeddings API, so a miss there silently degrades every upload to text-only
# search.
PROVIDER_VARS = (
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "QA_MODEL",
    "LOCAL_LLM_ENABLED",
    "QA_MAX_TOKENS",
    "OPENAI_MODEL",
    "EMBEDDING_MODEL",
    "LOCAL_LLM_BASE_URL",
    "LOCAL_LLM_MODEL",
    "OPENAI_BASE_URL",
)

# Variables whose application's own default is the empty string, so an empty
# Compose default is correct and matches the code.
# `QA_MODEL` and `LOCAL_LLM_ENABLED` are read live inside functions
# (qa.resolve_default_model, qa module header), so they have no module constant
# to compare against; the two keys are checked against the code defaults in
# qa.py / embedding.py, which are also "".
EMPTY_DEFAULT_VARS = (
    "OPENAI_API_KEY",
    "GROQ_API_KEY",
    "QA_MODEL",
    "LOCAL_LLM_ENABLED",
    "OPENAI_BASE_URL",
)

# Read the application's real defaults with the variables *absent*, so what is
# compared is the code's fallback rather than whatever the test process happens
# to inherit. Run in a subprocess because the constants are import-time.
_APP_DEFAULTS = """
import json
from app.services import embedding, qa

print(json.dumps({
    "OPENAI_MODEL": qa.OPENAI_MODEL,
    "LOCAL_LLM_BASE_URL": qa.LOCAL_LLM_BASE_URL,
    "LOCAL_LLM_MODEL": qa.LOCAL_LLM_MODEL,
    "QA_MAX_TOKENS": str(qa.QA_MAX_TOKENS),
    "EMBEDDING_MODEL": embedding.EMBEDDING_MODEL,
}))
"""


@pytest.fixture(scope="module")
def compose() -> dict:
    return yaml.safe_load(COMPOSE_PATH.read_text())


@pytest.fixture(scope="module")
def app_defaults() -> dict:
    """The value each variable falls back to in the application, var unset."""
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in ("OPENAI_MODEL", "LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL",
                     "QA_MAX_TOKENS", "EMBEDDING_MODEL")
    }
    # S603: the command is a literal argv list built here, with no shell and
    # no external input — sys.executable, -c, and a constant script.
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", _APP_DEFAULTS],
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        check=False,
    )
    assert result.returncode == 0, (
        "could not read the application's defaults:\n" + result.stderr
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("service", ["dev", "worker"])
def test_every_provider_variable_reaches_the_service(compose, service):
    environment = compose["services"][service]["environment"]

    missing = [name for name in PROVIDER_VARS if name not in environment]
    assert not missing, f"{service} does not receive: {missing}"


@pytest.mark.parametrize("service", ["dev", "worker"])
def test_provider_values_are_interpolated_not_literal(compose, service):
    """``${VAR:-...}``, so a root ``.env`` or a shell export reaches the sandbox.

    Also the reason no secret can be committed here: a literal value would show
    up in git. Every provider value must resolve from the environment.
    """
    environment = compose["services"][service]["environment"]

    for name in PROVIDER_VARS:
        value = environment[name]
        assert value.startswith("${") and value.endswith("}"), (
            f"{service}.{name} = {value!r} is a literal, not an interpolation"
        )
        # ${NAME:-default} — not ${NAME}, which would abort `compose config`
        # when the variable is unset.
        assert value.startswith(f"${{{name}:-"), (
            f"{service}.{name} = {value!r} must default with ${{{name}:-…}} so "
            "an unset variable does not break `docker compose config`"
        )


def test_empty_defaulted_variables_use_an_empty_compose_default(compose):
    for service in ("dev", "worker"):
        environment = compose["services"][service]["environment"]
        for name in EMPTY_DEFAULT_VARS:
            assert environment[name] == f"${{{name}:-}}", (
                f"{service}.{name} = {environment[name]!r}: the application "
                "defaults this to empty, so the Compose default must be too"
            )


def test_model_defaults_match_what_the_application_itself_defaults_to(
    compose, app_defaults
):
    """The drift guard.

    If either side changes alone, this fails and names both values — which is
    the only way the two stay in step, since the sandbox's environment silently
    overrides the code's fallback.
    """
    for service in ("dev", "worker"):
        environment = compose["services"][service]["environment"]
        for name, app_default in app_defaults.items():
            expected = f"${{{name}:-{app_default}}}"
            actual = environment[name]
            assert actual == expected, (
                f"{service}.{name} = {actual!r} but the application defaults to "
                f"{app_default!r}. An unset value in the sandbox would then "
                "override a working default with something else. Change both."
            )


def test_no_provider_value_looks_like_a_secret(compose):
    """Belt and braces on top of the interpolation test."""
    secretish = re.compile(r"(sk-[A-Za-z0-9]|gsk_[A-Za-z0-9]|Bearer\s)", re.I)

    for service in ("dev", "worker"):
        for name, value in compose["services"][service]["environment"].items():
            assert not secretish.search(str(value)), (
                f"{service}.{name} looks like it contains a credential: {value!r}"
            )


def test_both_services_can_reach_a_host_side_ollama(compose):
    """``host.docker.internal`` must resolve inside the sandbox (#486).

    Docker Desktop injects this name automatically; plain Linux Docker does not.
    Without the mapping the documented ``LOCAL_LLM_BASE_URL`` of
    ``http://host.docker.internal:11434/v1`` fails with "Could not resolve host"
    and the local provider is unusable — the failure is silent, because the QA
    layer then simply answers from another provider.

    ``host-gateway`` (not a literal IP) is required, because the bridge gateway
    differs between hosts and the daemon may be bound to a different one.
    """
    for service in ("dev", "worker"):
        extra_hosts = compose["services"][service].get("extra_hosts") or []
        assert "host.docker.internal:host-gateway" in extra_hosts, (
            f"{service} cannot resolve host.docker.internal, so a host-side "
            f"Ollama is unreachable (extra_hosts={extra_hosts!r}). Add "
            "'host.docker.internal:host-gateway' — DEVELOPMENT.md documents "
            "that name as the way to reach a local model."
        )


def test_no_service_maps_host_docker_internal_to_a_hardcoded_ip(compose):
    """The gateway must stay dynamic, not pinned to one machine's bridge."""
    for service, config in compose["services"].items():
        for mapping in config.get("extra_hosts") or []:
            host, _, target = str(mapping).partition(":")
            if host == "host.docker.internal":
                assert target == "host-gateway", (
                    f"{service} pins host.docker.internal to {target!r}; use "
                    "'host-gateway' so this works on any host."
                )
