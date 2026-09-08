import logging
import threading
import time
from queue import Queue
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.database.db import SessionLocal
from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.services.chunking import ChunkingService
from app.services.embedding import EmbeddingService
from app.services.search import invalidate_user_search_cache
from app.services.text_extraction import TextExtractionService
from app.storage.storage import storage

logger = logging.getLogger(__name__)

task_queue: Queue = Queue()
worker_thread: threading.Thread | None = None
is_running = False


def process_document_task(document_id: UUID):
    task_queue.put(("process_document", document_id))


def _invalidate_caches(document: DocumentDB) -> None:
    """Drop stale cached metadata + search results for a processed doc.

    Status transitions (READY/FAILED) change a document's row and its
    searchability, so cached document metadata and the user's cached
    search results must be invalidated. Imported lazily to avoid a
    circular import (services.document imports this module).
    """
    invalidate_user_search_cache(document.owner_id)
    try:
        from app.services.document import invalidate_document_cache

        invalidate_document_cache(document.owner_id, document.id)
    except Exception as e:  # noqa: BLE001 - cache must never break the worker
        logger.warning(f"Document cache invalidation failed: {e}")


def _process_document(document_id: UUID):
    db: Session = SessionLocal()
    try:
        repository = DocumentRepository(db)
        document = repository.get_by_id(document_id)

        if document is None:
            logger.error(f"Document not found: {document_id}")
            return

        repository.update_status(document_id, DocumentStatus.PROCESSING)

        try:
            file_content = storage.download(document.object_key)
            file_bytes = file_content.read()

            import io

            file_object = io.BytesIO(file_bytes)

            text_extraction = TextExtractionService()
            text = text_extraction.extract_text(
                file_object=file_object,
                mime_type=document.mime_type,
            )

            if not text.strip():
                repository.update_status(
                    document_id,
                    DocumentStatus.FAILED,
                    error_message="No text content could be extracted",
                )
                _invalidate_caches(document)
                return

            chunking = ChunkingService()
            chunks = chunking.chunk_text(text)

            embedding_service = EmbeddingService()

            # Generate embeddings for every chunk. This is best-effort:
            # if the OpenAI client is not configured (or the API call
            # fails), we still save the chunks without vectors so the
            # document remains searchable via plain text search.
            try:
                embeddings = embedding_service.generate_embeddings(
                    [chunk.content for chunk in chunks]
                )
            except Exception as e:  # noqa: BLE001 - worker must not fail on embedding issues
                logger.warning(
                    f"Embeddings unavailable for document {document_id}, "
                    f"saving chunks without vectors: {e}"
                )
                embeddings = [None] * len(chunks)

            from app.models.chunk import DocumentChunk

            for chunk, embedding in zip(chunks, embeddings):
                db_chunk = DocumentChunk(
                    document_id=document_id,
                    content=chunk.content,
                    chunk_index=chunk.chunk_index,
                    metadata_=chunk.metadata,
                    embedding=embedding,
                )
                db.add(db_chunk)

            db.commit()

            repository.update_status(document_id, DocumentStatus.READY)
            _invalidate_caches(document)
            logger.info(f"Document processed successfully: {document_id}")

        except Exception as e:
            logger.error(f"Error processing document {document_id}: {e}")
            repository.update_status(
                document_id,
                DocumentStatus.FAILED,
                error_message=str(e),
            )
            _invalidate_caches(document)

    finally:
        db.close()


def _worker_loop():
    global is_running
    is_running = True
    logger.info("Document processing worker started")

    while is_running:
        try:
            task_type, document_id = task_queue.get(timeout=1)

            if task_type == "process_document":
                _process_document(document_id)

            task_queue.task_done()

        except Exception:
            continue

    logger.info("Document processing worker stopped")


def start_worker():
    global worker_thread, is_running

    if worker_thread is not None and worker_thread.is_alive():
        logger.warning("Worker already running")
        return

    is_running = True
    worker_thread = threading.Thread(target=_worker_loop, daemon=True)
    worker_thread.start()


def stop_worker():
    global is_running
    is_running = False
    if worker_thread:
        worker_thread.join(timeout=5)
