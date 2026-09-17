"""Tests for Redis-backed caching (search results + document metadata).

Redis itself is not required: the tests swap the ``redis_client``
singleton's JSON methods for an in-memory fake, so the whole suite runs
deterministically anywhere (PostgreSQL-backed cases skip when PG is
unreachable, as usual).
"""

import json
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from app.cache.redis import redis_client
from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.document import DocumentRepository
from app.repositories.search import SearchRepository
from app.schemas.document import FileResponse, SearchResponse, SearchResult
from app.services.document import DocumentService
from app.services.search import (
    _SEARCH_VERSION_KEY,
    SearchService,
    invalidate_user_search_cache,
)
from app.worker import _invalidate_caches

DIM = 1536


def _make_vector(on_dim: int) -> list[float]:
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


def _embedding_service_mock() -> MagicMock:
    embedding = MagicMock()
    embedding.generate_embedding.return_value = _make_vector(0)
    return embedding


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

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ex=None):
        self.store[key] = value
        return True

    def delete(self, key):
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
        repo.search.return_value = ([_make_result()], 1)
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
        repo.search.return_value = ([_make_result()], 1)
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
        repo.search.return_value = ([_make_result()], 1)
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
        monkeypatch.setattr(redis_client, "get_json", lambda key: (_ for _ in ()).throw(RuntimeError("redis down")))
        repo = MagicMock()
        repo.search.return_value = ([_make_result()], 1)
        service = SearchService(
            repository=repo,
            embedding_service=_embedding_service_mock(),
        )

        response = service.search(user_id=uuid4(), query="q")

        assert repo.search.call_count == 1
        assert len(response.results) == 1

    def test_cache_write_failure_does_not_break_search(self, monkeypatch):
        monkeypatch.setattr(redis_client, "set_json", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("redis down")))
        repo = MagicMock()
        repo.search.return_value = ([_make_result()], 1)
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
        user = UserDB(username="carlos", hashed_password="x")
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
        user = UserDB(username="doc1", hashed_password="x")
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
        user = UserDB(username="doc2", hashed_password="x")
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

        user = UserDB(username="doc3", hashed_password="x")
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
        user = UserDB(username="doc4", hashed_password="x")
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

    def test_list_caches_pages_per_skip_limit(self, db_session, fake_redis):
        user = UserDB(username="doc5", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        for i in range(3):
            db_session.add(
                DocumentDB(
                    owner_id=user.id,
                    filename=f"list{i}.txt",
                    object_key=f"k/list{i}.txt",
                    status=DocumentStatus.READY,
                )
            )
        db_session.commit()

        service = self._service(db_session)
        first = service.list(owner_id=user.id, skip=0, limit=2)
        second = service.list(owner_id=user.id, skip=0, limit=2)

        assert [d.filename for d in first] == ["list2.txt", "list1.txt"]
        # The second call is served from cache (FileResponse), same data.
        assert [d.filename for d in second] == ["list2.txt", "list1.txt"]
        assert second[0].id == first[0].id
        assert fake_redis.get_json(f"doclist:{user.id}") is not None

        # A different page is fetched from the database and merged in.
        third = service.list(owner_id=user.id, skip=2, limit=2)
        assert [d.filename for d in third] == ["list0.txt"]
        pages = fake_redis.get_json(f"doclist:{user.id}")
        assert "0:2" in pages and "2:2" in pages

    def test_list_serves_cached_page_without_hitting_db(self, db_session, fake_redis):
        user = UserDB(username="doc6", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        service = self._service(db_session)
        # If the cached page is used, the repository is never consulted;
        # a call would raise and fail the test.
        service.repository.get_by_owner = MagicMock(side_effect=AssertionError("DB hit"))
        cached_files = [
            FileResponse(
                id=uuid4(),
                owner_id=user.id,
                filename="cached.txt",
                object_key="k/cached.txt",
                mime_type=None,
                status=DocumentStatus.READY,
                error_message=None,
                created_at="2024-01-01T00:00:00Z",
                updated_at="2024-01-01T00:00:00Z",
            )
        ]
        redis_client.set_json(
            f"doclist:{user.id}",
            {"0:20": [f.model_dump(mode="json") for f in cached_files]},
            ex=60,
        )

        result = service.list(owner_id=user.id, skip=0, limit=20)

        assert len(result) == 1
        assert result[0].filename == "cached.txt"

    def test_upload_invalidates_list_cache(self, db_session, fake_redis, monkeypatch):
        from app.services import document as document_module

        monkeypatch.setattr(
            document_module, "process_document_task", lambda _document_id: None
        )
        user = UserDB(username="doc7", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.commit()

        # Simulate a previously cached listing page.
        redis_client.set_json(f"doclist:{user.id}", {"0:20": []}, ex=60)

        upload_file = MagicMock()
        upload_file.filename = "up2.txt"
        upload_file.content_type = "text/plain"
        upload_file.file = MagicMock()
        upload_file.file.read.return_value = b"hello"

        service = self._service(db_session)
        service.upload(owner_id=user.id, upload_file=upload_file)

        assert f"doclist:{user.id}" not in fake_redis.store

    def test_delete_invalidates_list_cache(self, db_session, fake_redis):
        user = UserDB(username="doc8", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="d.txt",
            object_key="k/d.txt",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.commit()

        redis_client.set_json(f"doclist:{user.id}", {"0:20": []}, ex=60)

        service = self._service(db_session)
        service.delete(document_id=doc.id, owner_id=user.id)

        assert f"doclist:{user.id}" not in fake_redis.store


class TestRedisClientAtomicIncrement:
    def test_increment_with_ttl_round_trip(self):
        """Atomic INCR+EXPIRE against a real Redis (skipped when unavailable)."""
        try:
            if not redis_client.ping():
                pytest.skip("Redis unavailable")
        except Exception:
            pytest.skip("Redis unavailable")

        key = f"test:incr:{uuid4()}"
        try:
            assert redis_client.increment_with_ttl(key, ttl=30) == 1
            assert redis_client.increment_with_ttl(key, ttl=30) == 2
            ttl = redis_client.client.ttl(key)
            assert 0 < ttl <= 30
        finally:
            redis_client.client.delete(key)


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