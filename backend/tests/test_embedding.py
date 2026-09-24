"""Tests for the embedding service's bounded retry behavior."""

import pytest


def _fake_response():
    """A minimal embeddings response with one vector."""

    class _Data:
        embedding = [0.5, 0.25]

    class _Resp:
        data = [_Data()]

    return _Resp()


class _FakeClient:
    """Duck-typed OpenAI client that raises queued exceptions then succeeds."""

    def __init__(self, exc_queue=None):
        self.exc_queue = list(exc_queue or [])
        self.calls = 0

    @property
    def embeddings(self):
        return self

    def create(self, **kwargs):
        self.calls += 1
        if self.exc_queue:
            raise self.exc_queue.pop(0)
        return _fake_response()


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


class TestRetryOnTransientFailures:
    def test_succeeds_after_transient_failures(self, monkeypatch):
        embedding, sleeps = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_conn_error(), _rate_limit_error()])
        monkeypatch.setattr(embedding, "client", fake)

        result = embedding.EmbeddingService().generate_embeddings(["a", "b"])

        assert result == [[0.5, 0.25]]
        assert fake.calls == 3  # 1 attempt + 2 retries
        # Exponential backoff: base * 2^attempt -> 1.0s then 2.0s.
        assert sleeps == [1.0, 2.0]

    def test_gives_up_after_retries_exhausted(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_server_error()] * 10)
        monkeypatch.setattr(embedding, "client", fake)

        with pytest.raises(Exception, match="internal error"):
            embedding.EmbeddingService().generate_embeddings(["a"])

        assert fake.calls == embedding.EMBEDDING_RETRY_ATTEMPTS + 1

    def test_does_not_retry_client_errors(self, monkeypatch):
        embedding, sleeps = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_bad_request_error()])
        monkeypatch.setattr(embedding, "client", fake)

        with pytest.raises(Exception, match="bad request"):
            embedding.EmbeddingService().generate_embeddings(["a"])

        assert fake.calls == 1
        assert sleeps == []  # no backoff for non-retryable errors

    def test_single_embedding_uses_retry_too(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        fake = _FakeClient(exc_queue=[_conn_error()])
        monkeypatch.setattr(embedding, "client", fake)

        result = embedding.EmbeddingService().generate_embedding("a")

        assert result == [0.5, 0.25]
        assert fake.calls == 2

    def test_unconfigured_client_still_raises(self, monkeypatch):
        embedding, _ = _patch_module(monkeypatch)
        monkeypatch.setattr(embedding, "client", None)

        with pytest.raises(RuntimeError, match="not configured"):
            embedding.EmbeddingService().generate_embeddings(["a"])