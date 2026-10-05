"""Tests for provider environment-variable cleanup (``app.env``).

The behaviour these pin is not cosmetic: an empty ``OPENAI_BASE_URL`` silently
becomes the OpenAI client's base URL, and every request then fails with an
opaque ``APIConnectionError``. The compose file passes that variable through as
``${OPENAI_BASE_URL:-}``, so "set but blank" is a state the sandbox genuinely
produces.
"""

import os

import pytest
from openai import OpenAI

from app.env import drop_blank_provider_vars


@pytest.fixture(autouse=True)
def _restore_openai_base_url():
    """Keep the real value out of the assertions and back in afterwards.

    Without this, a developer who exports ``OPENAI_BASE_URL`` before running the
    suite loses it for the rest of the session — the function under test removes
    it from the environment for real, which is the point.
    """
    original = os.environ.get("OPENAI_BASE_URL")
    yield
    if original is None:
        os.environ.pop("OPENAI_BASE_URL", None)
    else:
        os.environ["OPENAI_BASE_URL"] = original


@pytest.mark.parametrize("blank", ["", "   ", "\t", "\n"])
def test_a_blank_base_url_is_removed_from_the_environment(blank):
    os.environ["OPENAI_BASE_URL"] = blank

    drop_blank_provider_vars()

    assert "OPENAI_BASE_URL" not in os.environ


def test_a_configured_base_url_is_left_exactly_as_it_is():
    os.environ["OPENAI_BASE_URL"] = "http://ollama:11434/v1"

    drop_blank_provider_vars()

    assert os.environ["OPENAI_BASE_URL"] == "http://ollama:11434/v1"


def test_running_twice_is_harmless():
    os.environ["OPENAI_BASE_URL"] = ""

    drop_blank_provider_vars()
    drop_blank_provider_vars()  # must not raise

    assert "OPENAI_BASE_URL" not in os.environ


def test_the_sdk_keeps_its_default_base_url_after_cleanup():
    """The consequence, not the mechanism.

    A client built after cleanup points at the real API. Without the cleanup it
    would be built with base_url "" and every call would fail to connect — the
    failure mode this whole module exists to prevent.
    """
    os.environ["OPENAI_BASE_URL"] = ""
    drop_blank_provider_vars()

    client = OpenAI(api_key="test-key")

    assert str(client.base_url) == "https://api.openai.com/v1/"


def test_the_blank_value_would_have_broken_the_client():
    """The counterfactual, so the test above cannot pass for the wrong reason.

    If a future SDK version stopped treating "" as a base URL, the guard would
    become unnecessary — and the test that asserts the good outcome would keep
    passing. This one fails in that world, telling us the workaround can go.
    """
    os.environ["OPENAI_BASE_URL"] = ""
    client_without_cleanup = OpenAI(api_key="test-key")
    drop_blank_provider_vars()
    client_with_cleanup = OpenAI(api_key="test-key")

    assert str(client_without_cleanup.base_url) == ""
    assert str(client_with_cleanup.base_url) == "https://api.openai.com/v1/"


def test_the_embedding_service_drops_a_blank_base_url_at_import():
    """The wiring, not just the helper.

    ``embedding.py`` calls the cleanup at import time because it builds its
    client at import time. Asserted by reloading the module with a blank value
    in the environment, which is exactly what the sandbox hands it.
    """
    import importlib

    import app.services.embedding as embedding

    os.environ["OPENAI_API_KEY"] = "test-key"
    os.environ["OPENAI_BASE_URL"] = ""
    try:
        reloaded = importlib.reload(embedding)
        assert reloaded._openai_client is not None
        assert str(reloaded._openai_client.base_url) == "https://api.openai.com/v1/"
    finally:
        os.environ.pop("OPENAI_API_KEY", None)
        importlib.reload(embedding)


def test_a_blank_local_base_url_falls_back_to_the_default():
    """A local server address that is set but empty must not become the base URL.

    Same hazard as `OPENAI_BASE_URL`, one module over: the OpenAI SDK
    distinguishes absent from empty, so `""` becomes the client's base_url and
    every local call fails with a bare "Connection error." against no host.

    The guard cannot come from `drop_blank_provider_vars()` — `local_provider`
    is imported *before* that call runs — so the read itself has to be
    blank-safe. This is the assertion that keeps that ordering from mattering.
    """
    import importlib

    import app.local_provider as local_provider

    original = os.environ.get("LOCAL_LLM_BASE_URL")
    os.environ["LOCAL_LLM_BASE_URL"] = ""
    try:
        reloaded = importlib.reload(local_provider)
        assert reloaded.LOCAL_LLM_BASE_URL == "http://localhost:11434/v1"
    finally:
        if original is None:
            os.environ.pop("LOCAL_LLM_BASE_URL", None)
        else:
            os.environ["LOCAL_LLM_BASE_URL"] = original
        importlib.reload(local_provider)


def test_a_configured_local_base_url_is_used_verbatim():
    """The positive case, so the test above is not just always-falling-back."""
    import importlib

    import app.local_provider as local_provider

    original = os.environ.get("LOCAL_LLM_BASE_URL")
    os.environ["LOCAL_LLM_BASE_URL"] = "http://ollama.internal:11434/v1"
    try:
        reloaded = importlib.reload(local_provider)
        assert reloaded.LOCAL_LLM_BASE_URL == "http://ollama.internal:11434/v1"
    finally:
        if original is None:
            os.environ.pop("LOCAL_LLM_BASE_URL", None)
        else:
            os.environ["LOCAL_LLM_BASE_URL"] = original
        importlib.reload(local_provider)
