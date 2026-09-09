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

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.services.chunking import TextChunk
from app.worker import (
    WorkerSettings,
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
    def chunk_text(self, text):
        return [
            TextChunk(
                content="hello world",
                chunk_index=0,
                metadata={"start_char": 0, "end_char": 11, "char_count": 11},
            )
        ]


class FakeEmbedder:
    def __init__(self, vectors: list | None = None, raise_error: bool = False):
        self.vectors = vectors if vectors is not None else [_make_vector(0)]
        self.raise_error = raise_error

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
        assert doc.error_message == "extraction boom"
        assert invalidated.call_count == 1
        assert invalidated.call_args.args[0].id == doc.id

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


class TestWorkerSettings:
    def test_settings_expose_task_and_limits(self):
        assert process_document in WorkerSettings["functions"]
        assert WorkerSettings["max_tries"] == 3

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
        assert "extraction boom" in body["error_message"]


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

    def test_marks_old_pending_and_processing_as_failed(self, db_session):
        old_pending = self._seed(db_session, DocumentStatus.PENDING, 45)
        old_processing = self._seed(db_session, DocumentStatus.PROCESSING, 45)

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(old_pending)
        db_session.refresh(old_processing)
        assert old_pending.status == DocumentStatus.FAILED
        assert old_processing.status == DocumentStatus.FAILED
        assert (
            old_pending.error_message
            == "Processing did not complete within the timeout"
        )

    def test_leaves_recent_documents_alone(self, db_session):
        recent_pending = self._seed(db_session, DocumentStatus.PENDING, 5)
        ready = self._seed(db_session, DocumentStatus.READY, 45)

        asyncio.run(recover_stale_documents({}))

        db_session.refresh(recent_pending)
        db_session.refresh(ready)
        assert recent_pending.status == DocumentStatus.PENDING
        assert ready.status == DocumentStatus.READY