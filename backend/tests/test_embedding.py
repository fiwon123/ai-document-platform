"""Tests for the embedding service (request batching + client construction).

External services are never called: the shared OpenAI client is replaced
with a fake that records each embeddings request.
"""

from types import SimpleNamespace

import pytest

from app.services import embedding as embedding_module
from app.services.embedding import EmbeddingService


class _FakeEmbeddingsAPI:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self._next_index = 0

    def create(self, *, model: str, input: str | list[str]) -> SimpleNamespace:
        items = input if isinstance(input, list) else [input]
        self.calls.append(list(items))
        # Embeddings are returned per request in input order; a global
        # counter lets callers verify ordering across batches.
        embeddings = [float(self._next_index + i) for i in range(len(items))]
        self._next_index += len(items)
        return SimpleNamespace(
            data=[SimpleNamespace(embedding=[v]) for v in embeddings]
        )


class _FakeClient:
    def __init__(self) -> None:
        self.embeddings = _FakeEmbeddingsAPI()


@pytest.fixture()
def fake_client(monkeypatch) -> _FakeClient:
    client = _FakeClient()
    monkeypatch.setattr(embedding_module, "client", client)
    return client


class TestGenerateEmbedding:
    def test_single_text_uses_one_request(self, fake_client):
        result = EmbeddingService().generate_embedding("hello")

        assert result == [0.0]
        assert fake_client.embeddings.calls == [["hello"]]

    def test_raises_without_configured_client(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "client", None)

        with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
            EmbeddingService().generate_embedding("hello")


class TestGenerateEmbeddings:
    def test_batches_when_exceeding_batch_size(self, monkeypatch, fake_client):
        monkeypatch.setattr(embedding_module, "EMBEDDING_BATCH_SIZE", 2)
        texts = [f"chunk-{i}" for i in range(5)]

        result = EmbeddingService().generate_embeddings(texts)

        # Order preserved across batches; the tail is a partial batch.
        assert result == [[float(i)] for i in range(5)]
        assert fake_client.embeddings.calls == [
            ["chunk-0", "chunk-1"],
            ["chunk-2", "chunk-3"],
            ["chunk-4"],
        ]

    def test_single_request_within_batch_size(self, monkeypatch, fake_client):
        monkeypatch.setattr(embedding_module, "EMBEDDING_BATCH_SIZE", 2048)

        EmbeddingService().generate_embeddings(["a", "b"])

        assert fake_client.embeddings.calls == [["a", "b"]]

    def test_empty_input_makes_no_requests(self, fake_client):
        assert EmbeddingService().generate_embeddings([]) == []
        assert fake_client.embeddings.calls == []

    def test_raises_without_configured_client(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "client", None)

        with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
            EmbeddingService().generate_embeddings(["hello"])


class TestClientConstruction:
    def test_no_client_without_api_key(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "OPENAI_API_KEY", "")
        assert embedding_module._build_client() is None

    def test_client_applies_explicit_timeout(self, monkeypatch):
        monkeypatch.setattr(embedding_module, "OPENAI_API_KEY", "sk-test")
        monkeypatch.setattr(embedding_module, "EMBEDDING_TIMEOUT_SECONDS", 120)

        client = embedding_module._build_client()

        assert client is not None
        # A hung embeddings call must fail within the configured timeout
        # instead of stalling the document pipeline indefinitely.
        assert client.timeout == 120
