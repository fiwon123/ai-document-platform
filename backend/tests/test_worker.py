"""Tests for the document processing worker (embedding generation)."""

from unittest.mock import patch
from uuid import uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.worker import _process_document


def _make_embeddings(texts: list[str]) -> list[list[float]]:
    """Deterministic placeholder embeddings per input text."""
    return [[0.001 + i] * 1536 for i in range(len(texts))]


def _create_document(db_session) -> DocumentDB:
    doc = DocumentDB(
        owner_id=uuid4(),
        filename="sample.txt",
        object_key=f"users/{uuid4()}/documents/{uuid4()}/sample.txt",
        mime_type="text/plain",
        status=DocumentStatus.PENDING,
    )
    db_session.add(doc)
    db_session.commit()
    return doc


def test_process_document_generates_and_saves_embeddings(db_session, clean_db):
    """The worker generates embedddings for every chunk and marks READY."""
    doc = _create_document(db_session)
    text = "The quick brown fox jumps over the lazy dog. " * 40

    with (
        patch("app.worker.storage") as mock_storage,
        patch(
            "app.services.embedding.EmbeddingService.generate_embeddings",
            side_effect=_make_embeddings,
        ) as mock_generate,
    ):
        mock_storage.download.return_value.read.return_value = text.encode()
        _process_document(doc.id)

    db_session.expire_all()
    refreshed = db_session.get(DocumentDB, doc.id)
    assert refreshed.status == DocumentStatus.READY

    chunks = (
        db_session.query(DocumentChunk)
        .filter(DocumentChunk.document_id == doc.id)
        .order_by(DocumentChunk.chunk_index)
        .all()
    )
    assert len(chunks) > 1
    assert all(chunk.embedding is not None for chunk in chunks)
    assert len(chunks[0].embedding) == 1536
    assert mock_generate.call_count == 1
    mock_storage.download.assert_called_once()


def test_process_document_without_embeddings_saves_chunks_without_vectors(
    db_session, clean_db
):
    """When embedding generation fails, chunks are still saved (no vectors)."""
    doc = _create_document(db_session)
    text = "Plain enough text to produce at least one chunk. " * 30

    with (
        patch("app.worker.storage") as mock_storage,
        patch(
            "app.services.embedding.EmbeddingService.generate_embeddings",
            side_effect=RuntimeError("OpenAI client not configured"),
        ),
    ):
        mock_storage.download.return_value.read.return_value = text.encode()
        _process_document(doc.id)

    db_session.expire_all()
    refreshed = db_session.get(DocumentDB, doc.id)
    assert refreshed.status == DocumentStatus.READY

    chunks = (
        db_session.query(DocumentChunk)
        .filter(DocumentChunk.document_id == doc.id)
        .all()
    )
    assert len(chunks) > 0
    assert all(chunk.embedding is None for chunk in chunks)


def test_process_document_marks_failed_when_extraction_fails(db_session, clean_db):
    """A hard pipeline failure (e.g. corrupted file) marks the document FAILED."""
    doc = _create_document(db_session)

    with (
        patch("app.worker.storage") as mock_storage,
        patch(
            "app.services.text_extraction.TextExtractionService.extract_text",
            side_effect=RuntimeError("cannot parse pdf"),
        ),
    ):
        mock_storage.download.return_value.read.return_value = b"broken"
        _process_document(doc.id)

    db_session.expire_all()
    refreshed = db_session.get(DocumentDB, doc.id)
    assert refreshed.status == DocumentStatus.FAILED
    assert "cannot parse pdf" in refreshed.error_message