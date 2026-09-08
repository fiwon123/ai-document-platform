import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from arq.worker import Retry
from sqlalchemy.orm import Session

from app.cache.redis import REDIS_PASSWORD
from app.database.db import SessionLocal
from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.services.chunking import ChunkingService
from app.services.embedding import EmbeddingService
from app.services.text_extraction import TextExtractionService
from app.storage.storage import storage

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
BACKOFF_SECONDS = 5

# Documents stuck in these states longer than this are recovered as failed.
RECOVERY_TIMEOUT_MINUTES = 30

# arq coroutine names are derived from the functions' ``__qualname__``; keep
# them unique and stable so enqueued jobs always resolve to the same handler.
_JOB_NAME = "process_document"


def worker_redis_settings() -> RedisSettings:
    """Build arq RedisSettings from the shared app environment variables."""
    return RedisSettings(
        host=os.getenv("REDIS_HOST", "localhost"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        database=int(os.getenv("REDIS_DB", "0")),
        password=REDIS_PASSWORD,
    )


def _invalidate_caches(document: DocumentDB) -> None:
    """Drop stale cached metadata + search results for a processed doc.

    Status transitions (READY/FAILED) change a document's row and its
    searchability, so cached document metadata and the user's cached
    search results must be invalidated. Imports are lazy to avoid a
    circular import (services.document imports this module). Failures are
    logged and swallowed so a Redis hiccup never fails a job.
    """
    try:
        from app.services.search import invalidate_user_search_cache

        invalidate_user_search_cache(document.owner_id)
    except Exception as e:  # noqa: BLE001 - cache must never break the worker
        logger.warning(f"Search cache invalidation failed: {e}")
    try:
        from app.services.document import invalidate_document_cache

        invalidate_document_cache(document.owner_id, document.id)
    except Exception as e:  # noqa: BLE001 - cache must never break the worker
        logger.warning(f"Document cache invalidation failed: {e}")


async def process_document(ctx: dict, document_id: str) -> None:
    """Process a single uploaded document end-to-end.

    Called by the arq worker. ``document_id`` arrives as a string (job
    args are serialized), so we parse it back to a UUID up front; a
    malformed id fails the job immediately rather than surfacing later.
    """
    document_uuid = UUID(document_id)
    db: Session = SessionLocal()
    try:
        repository = DocumentRepository(db)
        document = repository.get_by_id(document_uuid)

        if document is None:
            logger.error(f"Document not found: {document_uuid}")
            return

        repository.update_status(document_uuid, DocumentStatus.PROCESSING)

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
                    document_uuid,
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
                    f"Embeddings unavailable for document {document_uuid}, "
                    f"saving chunks without vectors: {e}"
                )
                embeddings = [None] * len(chunks)

            from app.models.chunk import DocumentChunk

            for chunk, embedding in zip(chunks, embeddings, strict=False):
                db.add(
                    DocumentChunk(
                        document_id=document_uuid,
                        content=chunk.content,
                        chunk_index=chunk.chunk_index,
                        metadata_=chunk.metadata,
                        embedding=embedding,
                    )
                )

            db.commit()

            repository.update_status(document_uuid, DocumentStatus.READY)
            _invalidate_caches(document)
            logger.info(f"Document processed successfully: {document_uuid}")

        except Exception as e:  # noqa: BLE001 - transient errors are retried
            job_try = int(ctx.get("job_try", 1))
            logger.error(
                f"Error processing document {document_uuid} "
                f"(try {job_try}/{MAX_RETRIES}): {e}"
            )
            if job_try >= MAX_RETRIES:
                # Final attempt exhausted — record the failure so the
                # document is never left stuck in a processing state.
                repository.update_status(
                    document_uuid,
                    DocumentStatus.FAILED,
                    error_message=str(e),
                )
                _invalidate_caches(document)
                raise
            # Transient failure: let arq retry with exponential backoff.
            raise Retry(defer=BACKOFF_SECONDS * (2 ** (job_try - 1))) from e

    finally:
        db.close()


async def _enqueue(document_id: UUID, pool: ArqRedis) -> None:
    await pool.enqueue_job(_JOB_NAME, str(document_id))


async def _enqueue_with_new_pool(document_id: UUID) -> None:
    pool = await create_pool(worker_redis_settings())
    try:
        await _enqueue(document_id, pool)
    finally:
        await pool.close()


def process_document_task(document_id: UUID) -> None:
    """Enqueue a document-processing job (synchronous facade for routes).

    FastAPI document endpoints are synchronous ``def`` handlers with no
    active event loop, so it is safe to drive the async enqueue via
    asyncio here. Raises on failure so callers can mark the document as
    failed instead of leaving it stuck in ``pending``.
    """
    asyncio.run(_enqueue_with_new_pool(document_id))


async def recover_stale_documents(ctx: dict) -> None:
    """Mark documents stuck in pending/processing as failed.

    Runs periodically via the arq cron. Covers jobs that never started
    (enqueue failed/lost) or workers that crashed mid-flight. A document
    that has been pending/processing for longer than
    ``RECOVERY_TIMEOUT_MINUTES`` is marked FAILED with a descriptive
    error so it never stays stuck forever.
    """
    cutoff = datetime.now(UTC) - timedelta(minutes=RECOVERY_TIMEOUT_MINUTES)
    db: Session = SessionLocal()
    try:
        stale = (
            db.query(DocumentDB)
            .filter(
                DocumentDB.status.in_(
                    [DocumentStatus.PENDING, DocumentStatus.PROCESSING]
                )
            )
            .filter(DocumentDB.created_at < cutoff)
            .all()
        )
        for document in stale:
            logger.warning(
                f"Recovering stale document {document.id} "
                f"(status={document.status.value}, created={document.created_at})"
            )
            document.status = DocumentStatus.FAILED
            document.error_message = (
                "Processing did not complete within the timeout"
            )
            _invalidate_caches(document)
        if stale:
            db.commit()
            logger.info(f"Recovered {len(stale)} stale document(s)")
    finally:
        db.close()


# arq CLI settings: module must expose ``WorkerSettings``. A dict is a valid
# WorkerSettingsType.
WorkerSettings = {
    "functions": [process_document],
    "cron_jobs": [
        (recover_stale_documents, "*/5 * * * *", False),
    ],
    "redis_settings": worker_redis_settings(),
    "max_tries": MAX_RETRIES,
}