"""Tests for the arq-based document processing worker.

The worker talks to PostgreSQL directly (no arq/Redis needed to test the
task itself). Enqueueing is exercised with mocks so no Redis is required.
"""

import asyncio
import io
import os
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

from app.models.chunk import (
    LOCAL_EMBEDDING_SPACE,
    OPENAI_EMBEDDING_SPACE,
    DocumentChunk,
)
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.services.chunking import TextChunk
from app.worker import (
    STALE_RECOVER_COUNTER_TTL_SECONDS,
    STALE_RECOVER_MAX_ATTEMPTS,
    WORKER_HEALTH_CHECK_KEY,
    WorkerSettings,
    _recovery_timeout_minutes,
    _worker_is_alive,
    process_document,
    process_document_task,
    recover_stale_documents,
)

DIM = 1536


def _make_vector(on_dim: int = 0) -> list[float]:
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


class FakeExtractor:
    def __init__(self, text: str = "hello world content"):
        self.text = text

    def extract_text(self, file_object, mime_type):
        return self.text


class FakeExtractorError:
    def extract_text(self, file_object, mime_type):
        raise RuntimeError("extraction boom")


class FakeChunker:
    def __init__(self, chunks=None):
        self.chunks = chunks

    def chunk_text(self, text):
        if self.chunks is not None:
            return self.chunks
        return [
            TextChunk(
                content="hello world",
                chunk_index=0,
                metadata={"start_char": 0, "end_char": 11, "char_count": 11},
            )
        ]


class FakeEmbedder:
    """Stands in for EmbeddingService, including which space it writes into.

    `space` and `model` are load-bearing in the pipeline, not decoration: the
    worker asks the embedder which space and model its vectors belong to, looks
    up the column for that space, and records the model on every row so a later
    search only compares vectors from the same model. Without them the worker
    would raise on `embedding_column_for(None)`.
    """

    def __init__(
        self,
        vectors: list | None = None,
        raise_error: bool = False,
        space: str | None = OPENAI_EMBEDDING_SPACE,
        model: str | None = "text-embedding-ada-002",
    ):
        self.vectors = vectors if vectors is not None else [_make_vector(0)]
        self.raise_error = raise_error
        self.space = space
        self.model = model

    def generate_embeddings(self, texts):
        if self.raise_error:
            raise RuntimeError("api key missing")
        return self.vectors


def _seed_pending_document(db_session) -> DocumentDB:
    user = UserDB(username="worker_test", hashed_password="x")  # noqa: S106
    db_session.add(user)
    db_session.flush()
    doc = DocumentDB(
        owner_id=user.id,
        filename="notes.txt",
        object_key=f"users/{user.id}/documents/x/notes.txt",
        mime_type="text/plain",
        status=DocumentStatus.PENDING,
    )
    db_session.add(doc)
    db_session.commit()
    return doc


def _patch_worker_deps(monkeypatch, extractor=None, embedder=None, chunker=None):
    from app.worker import storage as worker_storage

    monkeypatch.setattr(
        worker_storage, "download", lambda key: io.BytesIO(b"hello world content")
    )
    monkeypatch.setattr(
        "app.worker.TextExtractionService", lambda: extractor or FakeExtractor()
    )
    monkeypatch.setattr(
        "app.worker.ChunkingService", lambda: chunker or FakeChunker()
    )
    monkeypatch.setattr(
        "app.worker.EmbeddingService", lambda: embedder or FakeEmbedder()
    )
    invalidated = MagicMock()
    monkeypatch.setattr("app.worker._invalidate_caches", invalidated)
    return invalidated


class TestProcessDocumentTask:
    def test_marks_ready_and_saves_chunks_with_embeddings(self, db_session, monkeypatch):
        doc = _seed_pending_document(db_session)
        invalidated = _patch_worker_deps(monkeypatch)

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.READY

        chunks = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .all()
        )
        assert len(chunks) == 1
        assert chunks[0].content == "hello world"
        assert chunks[0].embedding == _make_vector(0)
        assert invalidated.call_count == 1
        assert invalidated.call_args.args[0].id == doc.id

    def test_bulk_saved_chunks_preserve_order_and_embeddings(
        self, db_session, monkeypatch
    ):
        """The bulk insert keeps chunk_index order and per-chunk vectors."""
        doc = _seed_pending_document(db_session)
        chunker = FakeChunker(
            chunks=[
                TextChunk(
                    content=f"section {i}",
                    chunk_index=i,
                    metadata={"start_char": i, "end_char": i + 1, "char_count": 1},
                )
                for i in range(3)
            ]
        )
        embedder = FakeEmbedder(vectors=[_make_vector(i) for i in range(3)])
        _patch_worker_deps(monkeypatch, chunker=chunker, embedder=embedder)

        asyncio.run(process_document({}, str(doc.id)))

        chunks = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .order_by(DocumentChunk.chunk_index.asc())
            .all()
        )
        assert [c.content for c in chunks] == ["section 0", "section 1", "section 2"]
        assert [c.embedding for c in chunks] == [
            _make_vector(0),
            _make_vector(1),
            _make_vector(2),
        ]
        assert all(c.id is not None for c in chunks)

    def test_saves_chunks_without_vectors_when_embeddings_unavailable(
        self, db_session, monkeypatch
    ):
        doc = _seed_pending_document(db_session)
        invalidated = _patch_worker_deps(
            monkeypatch, embedder=FakeEmbedder(raise_error=True)
        )

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.READY

        chunks = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .all()
        )
        assert len(chunks) == 1
        assert chunks[0].embedding is None
        assert invalidated.call_count == 1
        assert invalidated.call_args.args[0].id == doc.id


class TestEmbeddingSpaceWrite:
    """Where the worker's vector lands, and what is recorded alongside it.

    A write that names the wrong column, or records no model, is invisible
    until search stops finding the document — so these assert the columns
    themselves, not just that *a* vector was saved.
    """

    def _run(self, db_session, monkeypatch, embedder):
        doc = _seed_pending_document(db_session)
        _patch_worker_deps(monkeypatch, embedder=embedder)
        asyncio.run(process_document({}, str(doc.id)))
        db_session.refresh(doc)
        return doc, (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .one()
        )

    def test_openai_vectors_go_to_the_indexed_column_with_their_model(
        self, db_session, monkeypatch
    ):
        _, chunk = self._run(
            db_session,
            monkeypatch,
            FakeEmbedder(
                vectors=[_make_vector(0)],
                space=OPENAI_EMBEDDING_SPACE,
                model="text-embedding-ada-002",
            ),
        )

        assert chunk.embedding == _make_vector(0)
        # The local column must stay empty: the CHECK constraint allows it, and
        # only this test notices if a change starts filling it.
        assert chunk.embedding_local is None
        assert chunk.embedding_model == "text-embedding-ada-002"

    def test_local_vectors_go_to_the_local_column_with_their_model(
        self, db_session, monkeypatch
    ):
        """A 768-wide vector in the 1536-typed column would be rejected outright,
        so the column choice is not a preference — it is the only thing that
        lets a local model be used at all."""
        local_vector = [0.1] * 768
        _, chunk = self._run(
            db_session,
            monkeypatch,
            FakeEmbedder(
                vectors=[local_vector],
                space=LOCAL_EMBEDDING_SPACE,
                model="nomic-embed-text",
            ),
        )

        assert chunk.embedding_local == local_vector
        assert chunk.embedding is None
        assert chunk.embedding_model == "nomic-embed-text"

    def test_a_failed_embedding_records_no_model(self, db_session, monkeypatch):
        """A model with no vector would make a model filter match a row it
        cannot rank, so the model is written as NULL rather than omitted."""
        _, chunk = self._run(
            db_session, monkeypatch, FakeEmbedder(raise_error=True)
        )

        assert chunk.embedding is None
        assert chunk.embedding_local is None
        assert chunk.embedding_model is None

    def test_a_document_with_no_provider_configured_stays_keyword_searchable(
        self, db_session, monkeypatch
    ):
        """`space=None` is the fresh-checkout state: chunks are still saved, so
        the document is reachable by keyword rather than invisible."""
        _, chunk = self._run(
            db_session, monkeypatch, FakeEmbedder(space=None, model=None)
        )

        assert chunk.embedding is None
        assert chunk.embedding_local is None
        assert chunk.embedding_model is None

    def test_fails_when_no_text_extracted(self, db_session, monkeypatch):
        doc = _seed_pending_document(db_session)
        invalidated = _patch_worker_deps(monkeypatch, extractor=FakeExtractor(text="  "))

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert doc.error_message == "No text content could be extracted"
        assert invalidated.call_count == 1
        assert invalidated.call_args.args[0].id == doc.id

    def test_marks_failed_on_processing_error(self, db_session, monkeypatch):
        doc = _seed_pending_document(db_session)
        invalidated = _patch_worker_deps(
            monkeypatch, extractor=FakeExtractorError()
        )

        # job_try == MAX_RETRIES => final attempt: failure is recorded.
        with pytest.raises(RuntimeError, match="extraction boom"):
            asyncio.run(process_document({"job_try": 3}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        # The persisted message is generic — internal error details must
        # not reach the API payload (see worker error sanitization).
        assert doc.error_message == "Document processing failed"
        assert invalidated.call_count == 1
        assert invalidated.call_args.args[0].id == doc.id

    def test_inline_fallback_records_the_same_generic_message(self, db_session, monkeypatch):
        """The queue-down path must not be the one that leaks detail.

        `process_document_sync` persists its own message, and it used to persist
        `str(e)`. That made the two failure paths disagree: the arq path holds
        the "internal detail stays in the log" rule and the fallback did not, so a
        document failing while Redis was unavailable had a psycopg2 message —
        database host, container IP, port, user — rendered on the documents page.
        """
        from app.worker import GENERIC_PROCESSING_FAILURE, process_document_sync

        doc = _seed_pending_document(db_session)
        _patch_worker_deps(monkeypatch, extractor=FakeExtractorError())

        with pytest.raises(RuntimeError, match="extraction boom"):
            process_document_sync(doc.id)

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert doc.error_message == GENERIC_PROCESSING_FAILURE

    def test_inline_fallback_persists_no_infrastructure_detail(
        self, db_session, monkeypatch
    ):
        """A realistic exception, checked for the parts that must not survive.

        Asserted against a real `OperationalError` rather than a synthetic string,
        because the whole failure mode is "whatever the driver happened to put in
        the message" — a fabricated 'connection to postgres:5432' would pass
        against any implementation and prove nothing.
        """
        from sqlalchemy.exc import OperationalError

        from app.worker import process_document_sync

        class FailingExtractor:
            def extract_text(self, file_object, mime_type):
                raise OperationalError(
                    "SELECT 1",
                    {},
                    Exception(
                        'connection to server at "postgres" (172.24.0.3), port 5432 '
                        "failed: FATAL: password authentication failed for user "
                        '"postgres"'
                    ),
                )

        doc = _seed_pending_document(db_session)
        _patch_worker_deps(monkeypatch, extractor=FailingExtractor())

        with pytest.raises(OperationalError):
            process_document_sync(doc.id)

        db_session.refresh(doc)
        stored = doc.error_message or ""
        for leak in ("postgres", "172.24.0.3", "5432", "password", "OperationalError"):
            assert leak not in stored, f"{leak!r} leaked into error_message: {stored!r}"

    def test_inline_fallback_still_logs_the_detail(self, db_session, monkeypatch, caplog):
        """Withheld from the client, not lost: the log is where operators look."""
        import logging

        from app.worker import process_document_sync

        doc = _seed_pending_document(db_session)
        _patch_worker_deps(monkeypatch, extractor=FakeExtractorError())

        with caplog.at_level(logging.ERROR), pytest.raises(RuntimeError):
            process_document_sync(doc.id)

        assert "extraction boom" in caplog.text

    def test_processing_error_retries_when_tries_remain(self, db_session, monkeypatch):
        """Transient errors re-raise as arq Retry and keep PROCESSING."""
        from arq.worker import Retry

        doc = _seed_pending_document(db_session)
        _patch_worker_deps(monkeypatch, extractor=FakeExtractorError())

        with pytest.raises(Retry):
            asyncio.run(process_document({"job_try": 1}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.PROCESSING
        assert doc.error_message is None

    def test_missing_document_is_a_noop(self, db_session, monkeypatch):
        from app.worker import storage as worker_storage

        monkeypatch.setattr(worker_storage, "download", lambda key: io.BytesIO(b"x"))
        result = asyncio.run(process_document({}, str(uuid4())))
        assert result is None

    def test_malformed_document_id_raises(self, db_session):
        try:
            asyncio.run(process_document({}, "not-a-uuid"))
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError for malformed UUID")


class TestEnqueueFacade:
    def test_process_document_task_enqueues_job(self, monkeypatch):
        enqueue = AsyncMock()
        monkeypatch.setattr("app.worker._enqueue_with_retry", enqueue)
        document_id = uuid4()

        process_document_task(document_id)

        enqueue.assert_called_once_with(document_id)

    def test_enqueue_failure_falls_back_to_inline_processing(self, monkeypatch):
        """Queue transport failures fall back to synchronous processing
        instead of surfacing a cryptic error to the user."""
        async def boom(_):
            raise RuntimeError("redis down")

        monkeypatch.setattr("app.worker._enqueue_with_retry", boom)
        inline = MagicMock()
        monkeypatch.setattr("app.worker.process_document_sync", inline)

        # No exception: the document is processed inline as a fallback.
        process_document_task(uuid4())

        assert inline.call_count == 1

    def test_inline_fallback_failure_propagates(self, monkeypatch):
        """If the queue is down AND inline processing fails, the real
        processing error propagates so the upload route marks it failed."""

        async def boom(_):
            raise RuntimeError("redis down")

        monkeypatch.setattr("app.worker._enqueue_with_retry", boom)

        def inline_boom(_):
            raise RuntimeError("extraction boom")

        monkeypatch.setattr("app.worker.process_document_sync", inline_boom)

        with pytest.raises(RuntimeError, match="extraction boom"):
            process_document_task(uuid4())


class TestThumbnailGeneration:
    """Thumbnails are generated during processing — best-effort, PDFs only."""

    def _seed_pdf_document(self, db_session) -> DocumentDB:
        user = UserDB(
            username=f"thumb_{uuid4().hex[:8]}",
            hashed_password="x",  # noqa: S106
        )
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="report.pdf",
            object_key=f"users/{user.id}/documents/x/report.pdf",
            mime_type="application/pdf",
            status=DocumentStatus.PENDING,
        )
        db_session.add(doc)
        db_session.commit()
        return doc

    def test_pdf_document_gets_thumbnail(self, db_session, monkeypatch, pdf_bytes):
        """A renderable PDF upload ends READY with a stored thumbnail."""
        from app.worker import storage as worker_storage

        doc = self._seed_pdf_document(db_session)
        _patch_worker_deps(monkeypatch)
        monkeypatch.setattr(worker_storage, "download", lambda key: io.BytesIO(pdf_bytes))

        uploads: dict[str, bytes] = {}
        monkeypatch.setattr(
            worker_storage,
            "upload",
            lambda file_object, object_key, content_type=None: uploads.setdefault(
                object_key, file_object.read()
            ),
        )

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.READY
        assert doc.has_thumbnail is True

        folder, _ = os.path.split(doc.object_key)
        expected_key = f"{folder}/thumbnail.png"
        assert expected_key in uploads
        assert uploads[expected_key].startswith(b"\x89PNG")

    def test_text_document_gets_no_thumbnail(self, db_session, monkeypatch):
        """Non-PDF documents are never sent to the thumbnail pipeline."""
        from app.worker import storage as worker_storage

        doc = _seed_pending_document(db_session)  # notes.txt, text/plain
        _patch_worker_deps(monkeypatch)

        uploaded: list[str] = []
        monkeypatch.setattr(
            worker_storage,
            "upload",
            lambda file_object, object_key, content_type=None: uploaded.append(
                object_key
            ),
        )

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.READY
        assert doc.has_thumbnail is False
        assert uploaded == []

    def test_thumbnail_failure_does_not_fail_document(self, db_session, monkeypatch):
        """A corrupt/unrenderable PDF still becomes READY — no thumbnail."""
        from app.worker import storage as worker_storage

        doc = self._seed_pdf_document(db_session)
        _patch_worker_deps(monkeypatch)
        # download returns garbage: rendering raises, worker must swallow it.
        monkeypatch.setattr(
            worker_storage, "download", lambda key: io.BytesIO(b"not a real pdf")
        )

        asyncio.run(process_document({}, str(doc.id)))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.READY
        assert doc.has_thumbnail is False


class TestWorkerSettings:
    def test_settings_expose_task_and_limits(self):
        assert process_document in WorkerSettings["functions"]
        assert WorkerSettings["max_tries"] == 3
        # Large PDFs exceed arq's default 300s budget — the worker raises it.
        assert WorkerSettings["job_timeout"] == int(
            os.getenv("WORKER_JOB_TIMEOUT_SECONDS", "900")
        )

    def test_redis_settings_from_env(self):
        settings = WorkerSettings["redis_settings"]
        assert settings.host == os.getenv("REDIS_HOST", "localhost")
        assert settings.port == int(os.getenv("REDIS_PORT", "6379"))
        assert settings.database == int(os.getenv("REDIS_DB", "0"))


class TestUploadRouteEnqueues:
    def test_upload_creates_document_and_enqueues_processing(
        self, client, auth_headers, monkeypatch
    ):
        from app.services import document as document_service_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        enqueued = MagicMock()
        monkeypatch.setattr(
            document_service_module, "process_document_task", enqueued
        )

        resp = client.post(
            "/v1/documents/",
            files={"upload_file": ("notes.txt", b"hello world", "text/plain")},
            headers=auth_headers,
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["status"] == "pending"
        assert body["filename"] == "notes.txt"
        enqueued.assert_called_once_with(UUID(body["id"]))

    def test_upload_marks_failed_when_processing_fails(
        self, client, auth_headers, monkeypatch
    ):
        """Upload succeeds but the document is FAILED if processing (the
        inline fallback path) fails with a real processing error."""
        from app.services import document as document_service_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)

        def boom(_document_id):
            raise RuntimeError("extraction boom")

        monkeypatch.setattr(
            document_service_module, "process_document_task", boom
        )

        resp = client.post(
            "/v1/documents/",
            files={"upload_file": ("notes.txt", b"hello world", "text/plain")},
            headers=auth_headers,
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["status"] == "failed"
        assert "Failed to process document" in body["error_message"]
        # Raw exception internals are sanitized out of the response.
        assert "extraction boom" not in body["error_message"]


class _FakeRedis:
    """Minimal async stand-in for the worker's arq Redis client.

    Implements only what the stale-recovery sweep calls — ``exists`` for
    liveness and ``incr``/``expire`` for the bounded recovery budget — so
    the liveness-aware contract can be pinned without a real Redis.
    """

    def __init__(
        self,
        budgets: dict[str, int] | None = None,
        *,
        health_key: bool = False,
        fail_incr: bool = False,
        fail_exists: bool = False,
    ):
        self._budgets = dict(budgets or {})
        self._health_key = health_key
        self._fail_incr = fail_incr
        self._fail_exists = fail_exists
        self.expired: list[int] = []

    async def exists(self, key: str) -> int:
        if self._fail_exists:
            raise RuntimeError("redis down")
        if key == WORKER_HEALTH_CHECK_KEY:
            return int(self._health_key)
        return int(key in self._budgets)

    async def incr(self, key: str) -> int:
        if self._fail_incr:
            raise RuntimeError("redis down")
        self._budgets[key] = self._budgets.get(key, 0) + 1
        return self._budgets[key]

    async def expire(self, key: str, ttl: int) -> bool:
        self.expired.append(ttl)
        return True


def _patch_enqueue(monkeypatch, sink: list) -> None:
    """Record re-enqueue attempts instead of touching a real queue."""
    enqueued: list = sink

    async def _fake_enqueue(document_id):
        enqueued.append(document_id)

    monkeypatch.setattr("app.worker._enqueue_with_retry", _fake_enqueue)


class TestRecoverStaleDocuments:
    def _seed(self, db_session, status, minutes_old):
        from datetime import UTC, datetime, timedelta

        user = UserDB(username=f"recover_{uuid4().hex[:8]}", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="stale.txt",
            object_key=f"users/{user.id}/documents/x/stale.txt",
            mime_type="text/plain",
            status=status,
        )
        db_session.add(doc)
        db_session.flush()
        doc.created_at = datetime.now(UTC) - timedelta(minutes=minutes_old)
        db_session.commit()
        return doc

    def test_recovery_floor_tracks_job_timeout_and_retries(self, monkeypatch):
        """The recovery cutoff must never preempt jobs that are still
        legitimately retrying (job_timeout × max_tries), and an explicit
        larger override is honored."""
        from app.worker import MAX_RETRIES, WORKER_JOB_TIMEOUT_SECONDS

        default_floor = (WORKER_JOB_TIMEOUT_SECONDS // 60 + 1) * MAX_RETRIES
        assert _recovery_timeout_minutes() >= default_floor

        # An explicit override larger than the floor wins.
        monkeypatch.setenv("WORKER_RECOVERY_TIMEOUT_MINUTES", str(default_floor + 5))
        assert _recovery_timeout_minutes() == default_floor + 5

        # An override smaller than the floor is clamped up to it.
        monkeypatch.setenv("WORKER_RECOVERY_TIMEOUT_MINUTES", "1")
        assert _recovery_timeout_minutes() == default_floor

    def test_marks_old_pending_and_processing_as_failed(self, db_session):
        # Seeded well beyond the recovery floor (job_timeout × retries).
        old_pending = self._seed(db_session, DocumentStatus.PENDING, 120)
        old_processing = self._seed(db_session, DocumentStatus.PROCESSING, 120)

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(old_pending)
        db_session.refresh(old_processing)
        assert old_pending.status == DocumentStatus.FAILED
        assert old_processing.status == DocumentStatus.FAILED
        assert "Processing did not complete within the timeout" in (
            old_pending.error_message or ""
        )

    def test_preserves_existing_error_message(self, db_session):
        # A document that already records a real failure keeps it instead of
        # the generic timeout text, so users see what actually went wrong.
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        doc.error_message = "openai: connection reset"
        db_session.commit()

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert doc.error_message == "openai: connection reset"

    def test_leaves_recent_documents_alone(self, db_session):
        recent_pending = self._seed(db_session, DocumentStatus.PENDING, 5)
        ready = self._seed(db_session, DocumentStatus.READY, 45)

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(recent_pending)
        db_session.refresh(ready)
        assert recent_pending.status == DocumentStatus.PENDING
        assert ready.status == DocumentStatus.READY

    # ── Liveness-aware, bounded recovery ─────────────────────────────────
    #
    # With a real arq ctx (Redis always present) the sweep re-enqueues instead
    # of blind-failing. These tests pin that contract, plus the two
    # fail-fast paths that keep the bound from becoming an infinite loop.

    def test_re_enqueues_stale_documents_when_worker_down(self, db_session, monkeypatch):
        """Worker down ⇒ re-enqueue, do NOT blind-fail.

        The regression this guards: a routine worker restart used to fail
        every in-flight upload, even though those documents were fine.
        """
        old_pending = self._seed(db_session, DocumentStatus.PENDING, 120)
        old_processing = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(health_key=False)
        enqueued: list = []
        _patch_enqueue(monkeypatch, enqueued)

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(old_pending)
        db_session.refresh(old_processing)
        # Re-enqueued, and deliberately left in their current status: the
        # re-enqueued job owns the row from here.
        assert set(enqueued) == {old_pending.id, old_processing.id}
        assert old_pending.status == DocumentStatus.PENDING
        assert old_processing.status == DocumentStatus.PROCESSING
        assert not old_pending.error_message

    def test_re_enqueues_when_worker_alive_until_budget_exhausted(
        self, db_session, monkeypatch
    ):
        """Worker alive ⇒ still re-enqueue, but only within the budget."""
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(health_key=True)
        enqueued = []
        _patch_enqueue(monkeypatch, enqueued)

        for _ in range(STALE_RECOVER_MAX_ATTEMPTS):
            asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.PROCESSING
        assert len(enqueued) == STALE_RECOVER_MAX_ATTEMPTS

        # One tick past the budget ⇒ failed for real.
        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert "Processing did not complete within the timeout" in (
            doc.error_message or ""
        )
        assert len(enqueued) == STALE_RECOVER_MAX_ATTEMPTS

    def test_fails_stale_document_when_budget_exhausted(self, db_session, monkeypatch):
        """Pre-seeded exhausted budget ⇒ fail without re-enqueueing."""
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(
            health_key=False,
            budgets={f"stale-recover:{doc.id}": STALE_RECOVER_MAX_ATTEMPTS + 1},
        )
        enqueued = []
        _patch_enqueue(monkeypatch, enqueued)

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert enqueued == []

    def test_recovery_budget_preserves_real_error_on_fail_path(
        self, db_session, monkeypatch
    ):
        """A recorded error must survive the bounded-recovery fail path too.

    The re-enqueue rework must not regress the pre-existing behaviour where a
    genuine failure message is kept instead of the generic timeout text.
        """
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        doc.error_message = "openai: connection reset"
        db_session.commit()
        redis = _FakeRedis(
            health_key=False,
            budgets={f"stale-recover:{doc.id}": STALE_RECOVER_MAX_ATTEMPTS + 1},
        )
        _patch_enqueue(monkeypatch, [])

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert doc.error_message == "openai: connection reset"

    def test_fails_when_enqueue_itself_fails(self, db_session, monkeypatch):
        """A failed re-enqueue falls back to FAILED, never a silent retry."""
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(health_key=False)

        async def _boom(_document_id):
            raise RuntimeError("redis down")

        monkeypatch.setattr("app.worker._enqueue_with_retry", _boom)

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED

    def test_fails_when_budget_store_unavailable(self, db_session, monkeypatch):
        """If the budget cannot be counted, do not start an unbounded retry."""
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(health_key=False, fail_incr=True)
        enqueued = []
        _patch_enqueue(monkeypatch, enqueued)

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert enqueued == []

    def test_leaves_recent_documents_alone_with_redis_present(
        self, db_session, monkeypatch
    ):
        """The cutoff still applies on the re-enqueue path."""
        recent = self._seed(db_session, DocumentStatus.PENDING, 5)
        ready = self._seed(db_session, DocumentStatus.READY, 120)
        redis = _FakeRedis(health_key=False)
        enqueued = []
        _patch_enqueue(monkeypatch, enqueued)

        asyncio.run(recover_stale_documents({"redis": redis}))

        db_session.refresh(recent)
        db_session.refresh(ready)
        assert recent.status == DocumentStatus.PENDING
        assert ready.status == DocumentStatus.READY
        assert enqueued == []

    def test_budget_counter_gets_a_ttl_on_first_attempt(self, db_session, monkeypatch):
        """No TTL ⇒ the counter outlives nothing and the bound never trips."""
        self._seed(db_session, DocumentStatus.PROCESSING, 120)
        redis = _FakeRedis(health_key=False)
        _patch_enqueue(monkeypatch, [])

        asyncio.run(recover_stale_documents({"redis": redis}))

        assert redis.expired == [STALE_RECOVER_COUNTER_TTL_SECONDS]

    def test_no_redis_in_ctx_fails_fast_without_enqueueing(
        self, db_session, monkeypatch
    ):
        """No Redis ⇒ no budget, no enqueue ⇒ previous fail-fast behaviour."""
        doc = self._seed(db_session, DocumentStatus.PROCESSING, 120)
        enqueued = []
        _patch_enqueue(monkeypatch, enqueued)

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(doc)
        assert doc.status == DocumentStatus.FAILED
        assert enqueued == []


class TestWorkerLiveness:
    def test_reads_the_shared_health_check_key(self):
        redis = _FakeRedis(health_key=True)
        assert asyncio.run(_worker_is_alive(redis)) is True

    def test_absent_key_means_not_alive(self):
        assert asyncio.run(_worker_is_alive(_FakeRedis(health_key=False))) is False

    def test_missing_redis_means_not_alive(self):
        assert asyncio.run(_worker_is_alive(None)) is False

    def test_redis_error_means_not_alive(self):
        redis = _FakeRedis(health_key=True, fail_exists=True)
        assert asyncio.run(_worker_is_alive(redis)) is False

    def test_uses_the_same_key_as_the_health_endpoint(self):
        """Liveness must not drift from /v1/health's notion of 'alive'."""
        assert WORKER_HEALTH_CHECK_KEY == "arq:queue:health-check"