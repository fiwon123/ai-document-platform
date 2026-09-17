import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

from arq import create_pool, cron
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

# arq worker liveness: the worker refreshes this Redis key via ``psetex``
# every ``WORKER_HEALTH_CHECK_INTERVAL`` seconds (the default key name is
# ``<queue>:health-check``, see arq.connections). The health endpoint checks
# its presence so dashboards can report whether processing is available.
WORKER_HEALTH_CHECK_KEY = "arq:queue:health-check"
WORKER_HEALTH_CHECK_INTERVAL = 15  # seconds

# Enqueue resilience: transient Redis/queue failures are retried before we
# fall back to synchronous in-process processing (see process_document_task).
_ENQUEUE_RETRIES = 3
_ENQUEUE_BACKOFF_SECONDS = 0.4


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
    searchability, so cached document metadata, the user's cached search
    results, and any cached listing pages must be invalidated. Imports
    are lazy to avoid a circular import (services.document imports this
    module). Failures are logged and swallowed so a Redis hiccup never
    fails a job.
    """
    try:
        from app.services.search import invalidate_user_search_cache

        invalidate_user_search_cache(document.owner_id)
    except Exception as e:  # noqa: BLE001 - cache must never break the worker
        logger.warning(f"Search cache invalidation failed: {e}")
    try:
        from app.services.document import (
            invalidate_document_cache,
            invalidate_document_list_cache,
        )

        invalidate_document_cache(document.owner_id, document.id)
        invalidate_document_list_cache(document.owner_id)
    except Exception as e:  # noqa: BLE001 - cache must never break the worker
        logger.warning(f"Document cache invalidation failed: {e}")


def _mark_failed(document_id: UUID, error_message: str) -> None:
    """Record a processing failure without leaving the doc stuck.

    Used by the arq handler after the final retry and by the synchronous
    fallback; invalidates caches so clients stop seeing stale metadata.
    """
    db: Session = SessionLocal()
    try:
        repository = DocumentRepository(db)
        document = repository.update_status(
            document_id,
            DocumentStatus.FAILED,
            error_message=error_message,
        )
        if document is not None:
            _invalidate_caches(document)
    finally:
        db.close()


async def _process_document_impl(document_id: UUID) -> None:
    """Run the full processing pipeline once for a document.

    Raises on failure; the caller decides whether to retry (arq worker) or
    mark the document failed (synchronous fallback). ``document_id`` must
    already be a valid UUID.
    """
    db: Session = SessionLocal()
    try:
        repository = DocumentRepository(db)
        document = repository.get_by_id(document_id)

        if document is None:
            logger.error(f"Document not found: {document_id}")
            return

        repository.update_status(document_id, DocumentStatus.PROCESSING)

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

        for chunk, embedding in zip(chunks, embeddings, strict=False):
            db.add(
                DocumentChunk(
                    document_id=document_id,
                    content=chunk.content,
                    chunk_index=chunk.chunk_index,
                    metadata_=chunk.metadata,
                    embedding=embedding,
                )
            )

        db.commit()

        repository.update_status(document_id, DocumentStatus.READY)
        _invalidate_caches(document)
        logger.info(f"Document processed successfully: {document_id}")
    finally:
        db.close()


async def process_document(ctx: dict, document_id: str) -> None:
    """Process a single uploaded document end-to-end. arq worker entrypoint.

    ``document_id`` arrives as a string (job args are serialized), so we
    parse it back to a UUID up front; a malformed id fails the job
    immediately rather than surfacing later. Transient failures are
    retried by arq with exponential backoff; after ``MAX_RETRIES`` the
    document is marked FAILED so it is never left stuck.
    """
    document_uuid = UUID(document_id)
    try:
        await _process_document_impl(document_uuid)
    except Exception as e:  # noqa: BLE001 - transient errors are retried
        job_try = int(ctx.get("job_try", 1))
        logger.error(
            f"Error processing document {document_uuid} "
            f"(try {job_try}/{MAX_RETRIES}): {e}"
        )
        if job_try >= MAX_RETRIES:
            # Final attempt exhausted — record the failure so the
            # document is never left stuck in a processing state.
            _mark_failed(document_uuid, str(e))
            raise
        # Transient failure: let arq retry with exponential backoff.
        raise Retry(defer=BACKOFF_SECONDS * (2 ** (job_try - 1))) from e


async def _enqueue(document_id: UUID, pool: ArqRedis) -> None:
    await pool.enqueue_job(_JOB_NAME, str(document_id))


async def _enqueue_with_retry(document_id: UUID) -> None:
    """Enqueue a processing job, retrying transient Redis failures."""
    last_error: Exception | None = None
    for attempt in range(_ENQUEUE_RETRIES):
        pool: ArqRedis | None = None
        try:
            pool = await create_pool(worker_redis_settings())
            await _enqueue(document_id, pool)
            return
        except Exception as e:  # noqa: BLE001 - any enqueue failure is retried
            last_error = e
            logger.warning(
                f"Enqueue attempt {attempt + 1}/{_ENQUEUE_RETRIES} "
                f"failed for {document_id}: {e}"
            )
            if attempt < _ENQUEUE_RETRIES - 1:
                await asyncio.sleep(_ENQUEUE_BACKOFF_SECONDS * (2**attempt))
        finally:
            if pool is not None:
                try:
                    await pool.close()
                except Exception as e:  # noqa: BLE001 - close is best-effort
                    logger.debug(f"Ignoring pool close error: {e}")
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"enqueue failed for {document_id}")


def process_document_sync(document_id: UUID) -> None:
    """Process a document synchronously in the caller's thread.

    Fallback for when the Redis queue / arq worker is unavailable: runs
    the same pipeline as the worker so the document is still processed,
    never left stuck in ``pending``, and never marked failed just because
    of a queue transport problem. Raises on processing failure so callers
    can surface the real reason.
    """
    try:
        asyncio.run(_process_document_impl(document_id))
    except Exception as e:  # noqa: BLE001 - record the failure then re-raise
        logger.error(f"Synchronous processing failed for {document_id}: {e}")
        _mark_failed(document_id, str(e))
        raise


def process_document_task(document_id: UUID) -> None:
    """Start processing for an uploaded document (sync facade for routes).

    FastAPI document endpoints are synchronous ``def`` handlers with no
    active event loop, so it is safe to drive the async enqueue via
    asyncio here. Preferred path: enqueue a job for the arq worker. If the
    queue is unreachable (Redis down, worker never started), fall back to
    synchronous in-process processing so the document is never stuck in
    ``pending``.

    Raises only when processing actually fails (after the inline fallback);
    queue transport problems alone never surface a cryptic error to users.
    """
    try:
        asyncio.run(_enqueue_with_retry(document_id))
        logger.info(f"Enqueued document processing job: {document_id}")
    except Exception as e:  # noqa: BLE001 - fall back to inline processing
        logger.warning(f"Enqueue failed for {document_id} ({e}); processing inline")
        process_document_sync(document_id)


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


async def _worker_startup(ctx: dict) -> None:
    logger.info("Document processing worker started")
    if ctx.get("redis") is not None:
        # Refresh liveness immediately so /v1/health reports healthy early.
        try:
            await ctx["redis"].psetex(
                WORKER_HEALTH_CHECK_KEY,
                (WORKER_HEALTH_CHECK_INTERVAL + 1) * 1000,
                b"",
            )
        except Exception as e:  # noqa: BLE001 - best-effort
            logger.warning(f"Worker health check seed failed: {e}")


async def _worker_shutdown(ctx: dict) -> None:
    logger.info("Document processing worker stopped")


# arq CLI settings: module must expose ``WorkerSettings``. A dict is a valid
# WorkerSettingsType. The short health_check_interval keeps the health key
# fresh enough for /v1/health to report worker liveness (arq refreshes it via
# psetex every interval with a +1s TTL).
WorkerSettings = {
    "functions": [process_document],
    "cron_jobs": [
        # Every 5 minutes. arq >= 0.26 requires CronJob instances: the legacy
        # (coroutine, cron-string, unique) tuples are no longer accepted, so
        # build one with the cron() factory (minute set + second=0 == "*/5").
        cron(
            recover_stale_documents,
            minute={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
            second=0,
            unique=False,
        ),
    ],
    "redis_settings": worker_redis_settings(),
    "max_tries": MAX_RETRIES,
    "health_check_key": WORKER_HEALTH_CHECK_KEY,
    "health_check_interval": WORKER_HEALTH_CHECK_INTERVAL,
    "on_startup": _worker_startup,
    "on_shutdown": _worker_shutdown,
}