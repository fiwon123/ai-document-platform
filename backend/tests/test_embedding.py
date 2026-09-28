"""Tests for the embedding service: retries, provider selection, and widths.

The service has two embedding *spaces* and the width check is the part that
matters most, because it is the one failure that cannot be recovered from by
retrying and the one that would otherwise corrupt every later search.
"""

import pytest

# The widths these tests fake. Taken from the service's own config rather than
# written out, so a deliberate change to a space's declared width does not turn
# every test here into a false failure — and, more importantly, so a fake vector
# of the *wrong* width is always a deliberate choice in this file.
from app.services import embedding as embedding_module
from app.services.embedding import EmbeddingDimensionMismatch

OPENAI_WIDTH = embedding_module.OPENAI_SPACE_CONFIG.dimensions
LOCAL_WIDTH = embedding_module.LOCAL_SPACE_CONFIG.dimensions


def _vector(width: int) -> list[float]:
    return [0.5] * (width - 1) + [0.25]


def _fake_response(width: int = OPENAI_WIDTH):
    """A minimal embeddings response with one vector of the given width."""

    class _Data:
        embedding = _vector(width)

    class _Resp:
        data = [_Data()]

    return _Resp()


class _FakeClient:
    """Duck-typed OpenAI client that raises queued exceptions then succeeds."""

    def __init__(self, exc_queue=None, width: int = OPENAI_WIDTH):
        self.exc_queue = list(exc_queue or [])
        self.calls = 0
        self.width = width
        self.requested_models: list[str] = []

    @property
    def embeddings(self):
        return self

    def create(self, **kwargs):
        self.calls += 1
        if "model" in kwargs:
            self.requested_models.append(kwargs["model"])
        if self.exc_queue:
            raise self.exc_queue.pop(0)
        return _fake_response(self.width)


def _make_request():
    import httpx2

    return httpx2.Request("POST", "https://api.openai.com/v1/embeddings")


def _conn_error():
    import openai

    return openai.APIConnectionError(request=_make_request())


def _rate_limit_error():
    import httpx2
    import openai

    request = _make_request()
    return openai.RateLimitError(
        "rate limited", response=httpx2.Response(429, request=request), body=None
    )


def _server_error():
    import httpx2
    import openai

    request = _make_request()
    return openai.InternalServerError(
        "internal error", response=httpx2.Response(500, request=request), body=None
    )


def _bad_request_error():
    import httpx2
    import openai

    request = _make_request()
    return openai.BadRequestError(
        "bad request", response=httpx2.Response(400, request=request), body=None
    )


def _patch_module(monkeypatch):
    from app.services import embedding

    sleeps: list[float] = []
    monkeypatch.setattr(embedding, "time", _FakeTime(sleeps))
    return embedding, sleeps


class _FakeTime:
    def __init__(self, sleeps):
        self.sleeps = sleeps

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def _use_space(monkeypatch, module, space: str, client):
    """Select a space and its client, the way configuration would.

    Both module attributes are set rather than a single `client`, because the
    service keeps one client per space and reads them at call time — that is
    what lets a test exercise the local provider without an OpenAI key present.
    """
    monkeypatch.setattr(module, "ACTIVE_SPACE", space)
    monkeypatch.setattr(module, f"_{space}_client", client)
    return client


class TestRetryOnTransientFailures:
    def test_succeeds_after_transient_failures(self, monkeypatch):
        embedding, sleeps = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_conn_error(), _rate_limit_error()])
        _use_space(monkeypatch, embedding, "openai", fake)

        result = embedding.EmbeddingService().generate_embeddings(["a", "b"])

        assert result == [_vector(OPENAI_WIDTH)]
        assert fake.calls == 3  # 1 attempt + 2 retries
        # Exponential backoff: base * 2^attempt -> 1.0s then 2.0s.
        assert sleeps == [1.0, 2.0]

    def test_gives_up_after_retries_exhausted(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_server_error()] * 10)
        _use_space(monkeypatch, embedding, "openai", fake)

        with pytest.raises(Exception, match="internal error"):
            embedding.EmbeddingService().generate_embeddings(["a"])

        assert fake.calls == embedding.EMBEDDING_RETRY_ATTEMPTS + 1

    def test_does_not_retry_client_errors(self, monkeypatch):
        embedding, sleeps = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_bad_request_error()])
        _use_space(monkeypatch, embedding, "openai", fake)

        with pytest.raises(Exception, match="bad request"):
            embedding.EmbeddingService().generate_embeddings(["a"])

        assert fake.calls == 1
        assert sleeps == []  # no backoff for non-retryable errors

    def test_single_embedding_uses_retry_too(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_conn_error()])
        _use_space(monkeypatch, embedding, "openai", fake)

        result = embedding.EmbeddingService().generate_embedding("a")

        assert result == _vector(OPENAI_WIDTH)
        assert fake.calls == 2


class TestUnconfiguredProvider:
    def test_no_space_configured_raises_and_says_how_to_fix_it(self, monkeypatch):
        """No provider at all is the state a fresh checkout is in.

        It must raise rather than return an empty vector: the caller's own
        try/except is what degrades a document to keyword-searchable, and a
        silent empty result would write a chunk with no vector and no reason
        anywhere.
        """
        embedding, _ = _patch_module(monkeypatch)
        monkeypatch.setattr(embedding, "ACTIVE_SPACE", None)

        with pytest.raises(RuntimeError) as excinfo:
            embedding.EmbeddingService().generate_embeddings(["a"])

        message = str(excinfo.value)
        assert "No embedding provider is configured" in message
        # The message has to name both ways out, or the operator is left
        # guessing which variable to set.
        assert "OPENAI_API_KEY" in message
        assert "LOCAL_LLM_ENABLED" in message

    def test_selected_space_without_a_client_is_a_configuration_error(self, monkeypatch):
        """A space selected with no client is a code/config bug, not a blip."""
        embedding, _ = _patch_module(monkeypatch)
        _use_space(monkeypatch, embedding, "openai", None)

        with pytest.raises(RuntimeError, match="no client"):
            embedding.EmbeddingService().generate_embeddings(["a"])


class TestSpaceSelection:
    """Which space new vectors go into.

    The rule is deliberately "OpenAI first", not "newest wins": a deployment
    that has always embedded with OpenAI has vectors in the OpenAI space, and
    silently moving it to a local model because the operator also runs Ollama
    for chat would strand every one of them with nothing said.
    """

    def test_openai_key_selects_the_openai_space(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "OPENAI_API_KEY", "sk-test")
        monkeypatch.setattr(embedding_module, "LOCAL_LLM_ENABLED", True)

        assert embedding_module._resolve_active_space() == "openai"

    def test_local_only_falls_back_to_the_local_space(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "OPENAI_API_KEY", "")
        monkeypatch.setattr(embedding_module, "LOCAL_LLM_ENABLED", True)

        assert embedding_module._resolve_active_space() == "local"

    def test_neither_provider_configured_selects_nothing(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "OPENAI_API_KEY", "")
        monkeypatch.setattr(embedding_module, "LOCAL_LLM_ENABLED", False)

        assert embedding_module._resolve_active_space() is None

    def test_service_reports_the_space_and_model_it_writes(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        _use_space(monkeypatch, embedding, "local", _FakeClient(width=LOCAL_WIDTH))

        service = embedding.EmbeddingService()

        assert service.space == "local"
        # The model is what a later search filters on, so it must be the one
        # this space's config names — not a hardcoded default.
        assert service.model == embedding.LOCAL_SPACE_CONFIG.model

    def test_the_request_names_the_configured_model(self, monkeypatch):
        """A request sent with the wrong model name comes back wrong, silently."""
        embedding, _ = _patch_module(monkeypatch)
        fake = _use_space(
            monkeypatch, embedding, "local", _FakeClient(width=LOCAL_WIDTH)
        )

        embedding.EmbeddingService().generate_embedding("a")

        assert fake.requested_models == [embedding.LOCAL_SPACE_CONFIG.model]

    def test_unconfigured_service_reports_no_model(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        monkeypatch.setattr(embedding, "ACTIVE_SPACE", None)

        service = embedding.EmbeddingService()

        assert service.space is None
        assert service.model is None


class TestDimensionCheck:
    """The width check is what keeps two providers' vectors apart.

    A local embedding model is 384, 768 or 1024 wide depending on its name and
    the column cannot reject the wrong one, so without this check a
    misconfigured width would be written and every later search would fail
    against a mixed-width column — or, worse, rank vectors from unrelated spaces
    and return a confident wrong answer.
    """

    def test_wrong_width_is_refused_and_names_both_widths(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        # A local client answering with a 1536-wide vector: the exact mistake of
        # naming one model and configuring the width of another.
        fake = _FakeClient(width=OPENAI_WIDTH)
        _use_space(monkeypatch, embedding, "local", fake)

        with pytest.raises(EmbeddingDimensionMismatch) as excinfo:
            embedding.EmbeddingService().generate_embedding("a")

        message = str(excinfo.value)
        assert str(OPENAI_WIDTH) in message  # what the provider returned
        assert str(LOCAL_WIDTH) in message  # what was configured
        assert embedding.LOCAL_SPACE_CONFIG.model in message

    def test_mismatch_is_not_retried(self, monkeypatch):
        """Retrying cannot fix a configuration problem, so it must not try."""
        embedding, sleeps = _patch_module(monkeypatch)
        fake = _FakeClient(width=OPENAI_WIDTH)
        _use_space(monkeypatch, embedding, "local", fake)

        with pytest.raises(EmbeddingDimensionMismatch):
            embedding.EmbeddingService().generate_embeddings(["a"])

        assert fake.calls == 1
        assert sleeps == []

    def test_batched_call_is_refused_rather_than_partially_written(
        self, monkeypatch
    ):
        """One bad vector in a batch must reject the whole batch.

        Writing the good ones and skipping the bad one would leave a document
        with a mix of ranked and unranked chunks, and nothing recording which
        was which.
        """
        embedding, _ = _patch_module(monkeypatch)

        class _MixedClient(_FakeClient):
            def create(self, **kwargs):
                self.calls += 1

                class _Data:
                    def __init__(self, vector):
                        self.embedding = vector

                class _Resp:
                    data = [
                        _Data(_vector(LOCAL_WIDTH)),
                        _Data(_vector(OPENAI_WIDTH)),
                    ]

                return _Resp()

        _use_space(monkeypatch, embedding, "local", _MixedClient())

        with pytest.raises(EmbeddingDimensionMismatch):
            embedding.EmbeddingService().generate_embeddings(["a", "b"])

    def test_local_width_is_accepted_for_the_local_space(self, monkeypatch):
        """The positive case, so the test above is not just always-raising."""
        embedding, _ = _patch_module(monkeypatch)
        fake = _FakeClient(width=LOCAL_WIDTH)
        _use_space(monkeypatch, embedding, "local", fake)

        assert embedding.EmbeddingService().generate_embedding("a") == _vector(
            LOCAL_WIDTH
        )
