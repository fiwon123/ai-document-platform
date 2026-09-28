"""Tests for Redis-backed caching (search results + document metadata).

Redis itself is not required: the tests swap the ``redis_client``
singleton's JSON methods for an in-memory fake, so the whole suite runs
deterministically anywhere (PostgreSQL-backed cases skip when PG is
unreachable, as usual).
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from app.cache.redis import redis_client
from app.models.chunk import OPENAI_EMBEDDING_SPACE, DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.document import DocumentRepository
from app.repositories.search import SearchOutcome, SearchRepository
from app.schemas.document import FileResponse
from app.schemas.qa import QAResponse
from app.schemas.search import SearchMode, SearchResponse, SearchResult
from app.services.document import DocumentService
from app.services.qa import QAService
from app.services.search import (
    _SEARCH_VERSION_KEY,
    SearchService,
    invalidate_user_search_cache,
)
from app.services.statistics import StatisticsService
from app.worker import _invalidate_caches

DIM = 1536

# Chunk seeds must name the model: a vector search filters on
# `embedding_model`, so a chunk with a vector and a NULL model is
# deliberately invisible to it (that is what makes a pre-008 row safe).
SEED_MODEL = "text-embedding-ada-002"


def _make_vector(on_dim: int) -> list[float]:
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


def _embedding_service_mock() -> MagicMock:
    """An embedder double carrying a real space and model.

    Both are needed here, not just for the assertions: the search service
    forwards them to the repository so it reads the right column, and an
    auto-mocked `space` reaches `embedding_column_for` as a MagicMock and raises
    `KeyError` for an unknown space.
    """
    embedding = MagicMock()
    embedding.generate_embedding.return_value = _make_vector(0)
    embedding.space = OPENAI_EMBEDDING_SPACE
    embedding.model = SEED_MODEL
    return embedding


def _search_outcome(results):
    """A repository outcome carrying `results` and their count.

    The repository reports an outcome object rather than a `(results, count)`
    tuple, because the mode is part of the answer — a vector query the database
    refused comes back as `keyword` even though an embedding existed.
    """
    return SearchOutcome(results, len(results), SearchMode.semantic)


def _search_service_returning(results):
    """A search service stub whose response is a real SearchResponse.

    `QAService.ask` reads both `.results` and `.mode` off it, so a bare
    MagicMock answers `.mode` with another MagicMock and fails validation --
    which turns an under-specified mock into a confusing error rather than an
    obvious one.
    """
    stub = MagicMock()
    stub.search.return_value = SearchResponse(
        query="q", results=results, total_count=len(results), has_more=False
    )
    return stub


def _make_result(content: str = "c") -> SearchResult:
    return SearchResult(
        chunk_id=uuid4(),
        document_id=uuid4(),
        document_filename="a.txt",
        content=content,
        score=0.42,
    )


class FakeRedis:
    """In-memory stand-in for the JSON methods of RedisClient."""

    def __init__(self):
        self.store: dict[str, str] = {}
        self.counters: dict[str, int] = {}
        self.ttls: dict[str, int | None] = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ex=None):
        self.store[key] = value
        self.ttls[key] = ex
        return True

    def delete(self, key):
        self.ttls.pop(key, None)
        return self.store.pop(key, None) is not None

    def get_json(self, key):
        raw = self.store.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def set_json(self, key, value, ex=None):
        self.store[key] = json.dumps(value)
        self.ttls[key] = ex
        return True

    def increment(self, key):
        value = self.counters.get(key, 0) + 1
        self.counters[key] = value
        self.store[key] = str(value)
        return value


@pytest.fixture()
def fake_redis(monkeypatch):
    fake = FakeRedis()
    for method in ("get", "set", "delete", "get_json", "set_json", "increment"):
        monkeypatch.setattr(redis_client, method, getattr(fake, method))
    return fake


class TestSearchServiceCaching:
    def test_second_identical_search_is_served_from_cache(self, fake_redis):
        repo = MagicMock()
        repo.search.return_value = _search_outcome([_make_result()])
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )
        user_id = uuid4()

        first = service.search(user_id=user_id, query="hello", top_k=5)
        second = service.search(user_id=user_id, query="hello", top_k=5)

        assert repo.search.call_count == 1
        assert repo.save_search_history.call_count == 1
        assert first == second
        assert second.results[0].content == "c"

    def test_cache_key_includes_document_ids(self, fake_redis):
        repo = MagicMock()
        repo.search.return_value = _search_outcome([_make_result()])
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )
        user_id = uuid4()

        service.search(user_id=user_id, query="q", document_ids=[uuid4()])
        service.search(user_id=user_id, query="q", document_ids=[uuid4()])

        assert repo.search.call_count == 2

    def test_invalidation_forces_fresh_search(self, fake_redis):
        repo = MagicMock()
        repo.search.return_value = _search_outcome([_make_result()])
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )
        user_id = uuid4()

        service.search(user_id=user_id, query="q")
        service.search(user_id=user_id, query="q")
        assert repo.search.call_count == 1

        invalidate_user_search_cache(user_id)
        service.search(user_id=user_id, query="q")

        assert repo.search.call_count == 2
        assert fake_redis.counters[_SEARCH_VERSION_KEY.format(user_id=user_id)] == 1

    def test_cache_read_failure_falls_back_to_database(self, monkeypatch):
        def boom(key):
            raise RuntimeError("redis down")

        monkeypatch.setattr(redis_client, "get_json", boom)
        repo = MagicMock()
        repo.search.return_value = _search_outcome([_make_result()])
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )

        response = service.search(user_id=uuid4(), query="q")

        assert repo.search.call_count == 1
        assert len(response.results) == 1

    def test_cache_write_failure_does_not_break_search(self, monkeypatch):
        def boom(*args, **kwargs):
            raise RuntimeError("redis down")

        monkeypatch.setattr(redis_client, "set_json", boom)
        repo = MagicMock()
        repo.search.return_value = _search_outcome([_make_result()])
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )

        response = service.search(user_id=uuid4(), query="q")

        assert len(response.results) == 1

    def test_cached_response_round_trips_via_json(self, fake_redis):
        """Search results must survive JSON serialization (UUIDs etc.)."""
        result = _make_result()
        payload = SearchResponse(query="q", results=[result], total_count=1, has_more=False)
        redis_client.set_json("search:1", payload.model_dump(mode="json"))

        restored = redis_client.get_json("search:1")
        response = SearchResponse.model_validate(restored)

        assert response.results[0].chunk_id == result.chunk_id


class TestSearchCacheWithDatabase:
    def test_database_search_is_cached(self, db_session, fake_redis):
        user = UserDB(username="carlos", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()

        doc = DocumentDB(
            owner_id=user.id,
            filename="cache.txt",
            object_key="k/cache.txt",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="cached content",
                chunk_index=0,
                embedding=_make_vector(0),
                embedding_model=SEED_MODEL,
            )
        )
        db_session.commit()

        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=_embedding_service_mock(),
        )

        first = service.search(user_id=user.id, query="cached", top_k=5)
        second = service.search(user_id=user.id, query="cached", top_k=5)

        assert first == second
        assert len(first.results) == 1
        assert first.results[0].document_id == doc.id


class TestDocumentServiceCaching:
    def _service(self, db_session, storage=None):
        return DocumentService(
            repository=DocumentRepository(db_session),
            storage=storage or MagicMock(),
        )

    def test_get_caches_metadata_after_first_read(self, db_session, fake_redis):
        user = UserDB(username="doc1", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="f.txt",
            object_key="k/f.txt",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.commit()

        service = self._service(db_session)
        first = service.get(document_id=doc.id, owner_id=user.id)
        second = service.get(document_id=doc.id, owner_id=user.id)

        assert first.id == second.id == doc.id
        assert isinstance(second, FileResponse)
        assert second.status == DocumentStatus.READY

    def test_get_returns_none_when_missing(self, db_session, fake_redis):
        user = UserDB(username="doc2", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.commit()

        service = self._service(db_session)
        assert service.get(document_id=uuid4(), owner_id=user.id) is None

    def test_upload_invalidates_user_search_cache(
        self, db_session, fake_redis, monkeypatch
    ):
        from app.services import document as document_module

        # Enqueue is exercised elsewhere; here we only assert cache behavior.
        monkeypatch.setattr(
            document_module, "process_document_task", lambda _document_id: None
        )

        user = UserDB(username="doc3", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.commit()

        upload_file = MagicMock()
        upload_file.filename = "up.txt"
        upload_file.content_type = "text/plain"
        upload_file.file = MagicMock()
        upload_file.file.read.return_value = b"hello"

        service = self._service(db_session)
        created = service.upload(owner_id=user.id, upload_file=upload_file)

        assert created.status == DocumentStatus.PENDING
        assert fake_redis.counters[_SEARCH_VERSION_KEY.format(user_id=user.id)] == 1

    def test_delete_clears_document_and_search_caches(self, db_session, fake_redis):
        user = UserDB(username="doc4", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="del.txt",
            object_key="k/del.txt",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.commit()

        service = self._service(db_session)
        service.get(document_id=doc.id, owner_id=user.id)  # populate cache
        service.delete(document_id=doc.id, owner_id=user.id)

        document_key = f"document:{user.id}:{doc.id}"
        assert document_key not in fake_redis.store
        assert fake_redis.counters[_SEARCH_VERSION_KEY.format(user_id=user.id)] == 1


class TestRedisClientConfig:
    """Configuration of the Redis client itself (pool sizing)."""

    def test_max_connections_applied_to_pool(self, monkeypatch):
        import app.cache.redis as cache_redis

        monkeypatch.setattr(cache_redis, "REDIS_MAX_CONNECTIONS", 7)
        client = cache_redis.RedisClient()

        # The pool is created eagerly; no connection is opened until first use.
        assert client.client.connection_pool.max_connections == 7


class TestWorkerCacheInvalidation:
    def test_status_transition_invalidates_caches(self, fake_redis):
        user_id = uuid4()
        doc_id = uuid4()
        document = DocumentDB(
            id=doc_id,
            owner_id=user_id,
            filename="w.txt",
            object_key="k/w.txt",
            status=DocumentStatus.PROCESSING,
        )

        _invalidate_caches(document)

        assert fake_redis.counters[_SEARCH_VERSION_KEY.format(user_id=user_id)] == 1
        assert f"document:{user_id}:{doc_id}" not in fake_redis.store


class TestQAServiceCaching:
    """Repeated identical questions must be served from cache (no LLM call)."""

    def _service(self, monkeypatch, answer="Cached LLM answer"):
        from app.services import qa as qa_module

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=answer))]
        )
        # Every provider, not just OpenAI. `ask` resolves a model to a provider
        # and reads that provider's client off the module at call time, so
        # patching only `_openai_client` works only where nothing else is
        # configured. With a real GROQ_API_KEY in the environment the
        # free-first resolver picks Groq and answers from a live client instead
        # of this mock — making a real network call and failing on its reply.
        for attr in ("_openai_client", "_groq_client", "_local_client"):
            monkeypatch.setattr(qa_module, attr, fake_client)

        fake_search = MagicMock()
        # A real SearchResponse, not a bare MagicMock: `ask()` reads .results
        # AND .mode off it, and a mock answers .mode with another mock, which
        # fails validation and hides what the service actually depends on.
        fake_search.search.return_value = SearchResponse(
            query="q",
            results=[
                SearchResult(
                    chunk_id=uuid4(),
                    document_id=uuid4(),
                    document_filename="a.txt",
                    content="context",
                    score=0.5,
                )
            ],
            total_count=1,
            has_more=False,
        )
        return QAService(search_service=fake_search), fake_client, fake_search

    def test_second_identical_ask_served_from_cache(self, fake_redis, monkeypatch):
        service, fake_client, fake_search = self._service(monkeypatch)
        user_id = uuid4()

        first = service.ask(user_id=user_id, question="what is revenue?")
        second = service.ask(user_id=user_id, question="what is revenue?")

        assert fake_client.chat.completions.create.call_count == 1
        # The cache hit skips the search too.
        assert fake_search.search.call_count == 1
        assert first.answer == second.answer == "Cached LLM answer"
        assert first.question == second.question == "what is revenue?"

    def test_cache_entries_keyed_by_model(self, fake_redis, monkeypatch):
        service, fake_client, _ = self._service(monkeypatch)
        user_id = uuid4()

        service.ask(user_id=user_id, question="q", model="gpt-4o-mini")
        service.ask(user_id=user_id, question="q", model="gpt-4o")

        assert fake_client.chat.completions.create.call_count == 2

    def test_invalidation_forces_fresh_answer(self, fake_redis, monkeypatch):
        service, fake_client, _ = self._service(monkeypatch)
        user_id = uuid4()

        service.ask(user_id=user_id, question="q")
        assert fake_client.chat.completions.create.call_count == 1

        # Document set changed (upload/delete/processing) → cached answer is stale.
        invalidate_user_search_cache(user_id)
        service.ask(user_id=user_id, question="q")

        assert fake_client.chat.completions.create.call_count == 2

    def test_byok_never_cached(self, fake_redis, monkeypatch):
        from app.services import qa as qa_module

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="BYOK answer"))]
        )
        # BYOK builds a throwaway client through the OpenAI factory.
        monkeypatch.setattr(
            qa_module,
            "OpenAI",
            lambda api_key=None, base_url=None, max_retries=None: fake_client,
        )

        service = QAService(search_service=_search_service_returning([]))
        user_id = uuid4()

        service.ask(user_id=user_id, question="q", api_key="sk-user-secret")
        service.ask(user_id=user_id, question="q", api_key="sk-user-secret")

        # BYOK answers are never written to or read from the cache.
        assert fake_client.chat.completions.create.call_count == 2

    def test_uncacheable_error_answer_not_cached(self, fake_redis, monkeypatch):
        from app.services import qa as qa_module

        failing_client = MagicMock()
        failing_client.chat.completions.create.side_effect = RuntimeError("boom")
        # All providers, for the reason given in `_service`: patching only
        # `_openai_client` lets a configured Groq key answer from a real client
        # and this test then asserts against the wrong mock.
        for attr in ("_openai_client", "_groq_client", "_local_client"):
            monkeypatch.setattr(qa_module, attr, failing_client)

        service = QAService(search_service=_search_service_returning([]))
        user_id = uuid4()

        first = service.ask(user_id=user_id, question="q")
        second = service.ask(user_id=user_id, question="q")

        assert failing_client.chat.completions.create.call_count == 2
        assert first.answer == second.answer
        assert "Could not generate an answer" in first.answer

    def test_cached_response_round_trips_via_json(self, fake_redis):
        """QA answers with sources must survive JSON serialization."""
        result = _make_result()
        response = QAResponse(
            question="q",
            answer="a",
            sources=[result],
            model="gpt-4o-mini",
        )
        redis_client.set_json("qa:1", response.model_dump(mode="json"))

        restored = QAResponse.model_validate(redis_client.get_json("qa:1"))

        assert restored.sources[0].chunk_id == result.chunk_id
        assert restored.answer == "a"
        assert restored.model == "gpt-4o-mini"

    def test_cached_answer_uses_expected_ttl(self, fake_redis, monkeypatch):
        from app.services.qa import QA_CACHE_TTL_SECONDS

        service, _, _ = self._service(monkeypatch)
        user_id = uuid4()

        service.ask(user_id=user_id, question="q")

        qa_keys = [key for key in fake_redis.ttls if key.startswith("qa:")]
        assert len(qa_keys) == 1
        assert fake_redis.ttls[qa_keys[0]] == QA_CACHE_TTL_SECONDS

    def test_question_normalization_dedupes_cache_entries(self, fake_redis, monkeypatch):
        service, fake_client, _ = self._service(monkeypatch)
        user_id = uuid4()

        service.ask(user_id=user_id, question="What is revenue?")
        service.ask(user_id=user_id, question="  what is revenue? ")

        # Case and surrounding whitespace must hit the same cache entry.
        assert fake_client.chat.completions.create.call_count == 1


class TestStatisticsCaching:
    def test_user_summary_served_from_cache(self, fake_redis):
        repo = MagicMock()
        repo.status_counts.return_value = {DocumentStatus.READY: 2}
        repo.recent_documents.return_value = []
        repo.chunk_count.return_value = 5
        service = StatisticsService(repository=repo)
        user_id = uuid4()

        first = service.get_summary(user_id)
        second = service.get_summary(user_id)

        assert repo.status_counts.call_count == 1
        assert repo.chunk_count.call_count == 1
        assert first == second
        assert first.total_documents == 2
        assert first.total_chunks == 5

    def test_user_summary_invalidation_forces_fresh(self, fake_redis):
        repo = MagicMock()
        repo.status_counts.return_value = {DocumentStatus.READY: 1}
        repo.recent_documents.return_value = []
        repo.chunk_count.return_value = 1
        service = StatisticsService(repository=repo)
        user_id = uuid4()

        service.get_summary(user_id)
        invalidate_user_search_cache(user_id)
        service.get_summary(user_id)

        assert repo.status_counts.call_count == 2

    def test_stats_entries_use_expected_ttls(self, fake_redis):
        from app.services.statistics import (
            ADMIN_STATS_CACHE_TTL_SECONDS,
            USER_STATS_CACHE_TTL_SECONDS,
        )

        repo = MagicMock()
        repo.status_counts.return_value = {DocumentStatus.READY: 1}
        repo.recent_documents.return_value = []
        repo.chunk_count.return_value = 1
        repo.user_status_counts.return_value = {True: 1}
        repo.all_status_counts.return_value = {DocumentStatus.READY: 1}
        repo.all_chunk_count.return_value = 1
        repo.all_search_count.return_value = 1
        service = StatisticsService(repository=repo)

        service.get_summary(uuid4())
        service.get_admin_summary()

        assert fake_redis.ttls["stats:admin"] == ADMIN_STATS_CACHE_TTL_SECONDS
        me_keys = [key for key in fake_redis.ttls if key.startswith("stats:me:")]
        assert len(me_keys) == 1
        assert fake_redis.ttls[me_keys[0]] == USER_STATS_CACHE_TTL_SECONDS

    def test_admin_summary_served_from_cache(self, fake_redis):
        repo = MagicMock()
        repo.user_status_counts.return_value = {True: 2, False: 1}
        repo.all_status_counts.return_value = {DocumentStatus.READY: 1}
        repo.all_chunk_count.return_value = 3
        repo.all_search_count.return_value = 7
        service = StatisticsService(repository=repo)

        first = service.get_admin_summary()
        second = service.get_admin_summary()

        assert repo.user_status_counts.call_count == 1
        assert repo.all_chunk_count.call_count == 1
        assert first == second
        assert first.total_users == 3
        assert first.total_searches == 7

    def test_cache_failures_fall_back_to_database(self, monkeypatch):
        """A Redis outage mid-request must never break the dashboard query."""
        monkeypatch.setattr(redis_client, "get", lambda key: "0")
        monkeypatch.setattr(
            redis_client,
            "get_json",
            lambda key: (_ for _ in ()).throw(RuntimeError("redis down")),
        )
        monkeypatch.setattr(
            redis_client,
            "set_json",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("redis down")),
        )
        repo = MagicMock()
        repo.status_counts.return_value = {DocumentStatus.READY: 1}
        repo.recent_documents.return_value = []
        repo.chunk_count.return_value = 1
        service = StatisticsService(repository=repo)

        response = service.get_summary(uuid4())

        assert response.total_documents == 1
        assert repo.status_counts.call_count == 1