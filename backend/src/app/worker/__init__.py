import asyncio
import io
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
from app.logging_config import setup_logging
from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.schemas.webhook import WebhookEvent
from app.services.chunking import ChunkingService
from app.services.embedding import EmbeddingService
from app.services.text_extraction import TextExtractionService
from app.services.thumbnail import (
    can_render_thumbnail,
    thumbnail_object_key,
    thumbnail_service,
)
from app.storage.storage import storage

logger = logging.getLogger(__name__)

# Structured JSON logging for production (Loki/Promtail); no-op unless
# LOG_FORMAT=json is set.
setup_logging()

MAX_RETRIES = int(os.getenv("WORKER_MAX_RETRIES", "3"))
BACKOFF_SECONDS = int(os.getenv("WORKER_BACKOFF_SECONDS", "5"))

# A single pipeline run (extraction → chunking → embeddings → thumbnail) can
# legitimately take a while for large PDFs; arq's default job_timeout (300s)
# kills those jobs mid-flight. Raised to a configurable default and exposed
# to arq via the WorkerSettings dict below.
WORKER_JOB_TIMEOUT_SECONDS = int(os.getenv("WORKER_JOB_TIMEOUT_SECONDS", "900"))


def _recovery_timeout_minutes() -> int:
    """Recovery cutoff for documents stuck in pending/processing.

    The floor is derived from the job timeout × retries so the recovery cron
    never marks a job failed while it is still legitimately retrying; an
    explicit WORKER_RECOVERY_TIMEOUT_MINUTES still wins when it is larger.
    """
    min_floor = (WORKER_JOB_TIMEOUT_SECONDS // 60 + 1) * MAX_RETRIES
    return max(
        int(os.getenv("WORKER_RECOVERY_TIMEOUT_MINUTES", "30")),
        min_floor,
    )


RECOVERY_TIMEOUT_MINUTES = _recovery_timeout_minutes()

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

# Stale-document recovery. A document that is pending/processing while the
# worker is *down* is not stuck — processing simply is not running — so the
# recovery cron re-enqueues it instead of failing it. The re-enqueue is
# bounded per document so a genuinely wedged/broken document still reaches
# FAILED with a descriptive message rather than being re-enqueued forever.
#
# The TTL must comfortably exceed ``STALE_RECOVER_MAX_ATTEMPTS`` × the cron
# period (5 min), otherwise the counter would expire between attempts and the
# budget would reset, making the bound meaningless. 1h vs ~20 min of attempts.
STALE_RECOVER_MAX_ATTEMPTS = 3
STALE_RECOVER_COUNTER_TTL_SECONDS = 60 * 60  # 1h window per recovery attempt
_STALE_RECOVER_KEY_PREFIX = "stale-recover:"


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


def _schedule_webhook(event: WebhookEvent, document: DocumentDB) -> None:
    """Fire a document webhook event in the background (best-effort).

    The snapshot is taken eagerly — while the worker session is open — and
    delivery runs as a detached asyncio task so receiver latency and
    retries never slow down the pipeline; the service swallows all delivery
    errors. Import is lazy to keep the worker's dependency surface small; a
    schedule failure is logged and ignored.
    """
    try:
        from app.services.webhook import dispatch_document_event, document_event_info

        info = document_event_info(document)
        asyncio.create_task(dispatch_document_event(event.value, info))
    except Exception as e:  # noqa: BLE001 - webhooks must never break the worker
        logger.warning(f"Webhook scheduling failed for {event.value}: {e}")


def _mark_failed(document_id: UUID, error_message: str) -> DocumentDB | None:
    """Record a processing failure without leaving the doc stuck.

    Used by the arq handler after the final retry and by the synchronous
    fallback; invalidates caches so clients stop seeing stale metadata.
    Returns the updated document (None when it no longer exists) so callers
    can fire webhook notifications for the failure.
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
        return document
    finally:
        db.close()


def _generate_thumbnail(
    db: Session,
    document: DocumentDB,
    file_bytes: bytes,
) -> None:
    """Render and store a visual thumbnail for a PDF document.

    Best-effort by design: a corrupt or encrypted PDF (or a storage
    hiccup) must never fail the document — the text pipeline already
    succeeded and the document should still become READY. Callers keep
    ``document`` attached to ``db`` so the flag update commits together
    with the processing transaction.
    """
    if not can_render_thumbnail(document.mime_type, document.filename):
        return

    png_bytes = thumbnail_service.render_png(file_bytes)
    object_key = thumbnail_object_key(document.object_key)
    storage.upload(
        file_object=io.BytesIO(png_bytes),
        object_key=object_key,
        content_type="image/png",
    )
    try:
        document.has_thumbnail = True
        db.commit()
    except Exception:
        db.rollback()
        # The flag was never persisted: remove the orphaned object so
        # storage does not leak under a document that reports no thumbnail.
        storage.delete(object_key)
        raise


def _vector_fields(
    embedding: list[float] | None,
    embedding_column,
    model: str | None,
) -> dict:
    """The vector-related columns for one chunk row.

    Split out because the interesting part is what happens when there is *no*
    vector, and that used to be a single expression buried in a comprehension.
    The rules:

    * no provider configured -> no column, and no model. `embedding_column` is
      None and a vector cannot exist.
    * a vector -> the space's column, and the model that produced it, so a
      search can find it again and refuse to compare it with another model's.
    * no vector (provider failed, or the width was wrong) -> nothing set, and
      `embedding_model` explicitly NULL: claiming a model for a row that has no
      vector would make a model filter match rows it cannot rank.
    """
    if embedding is None or embedding_column is None:
        return {"embedding_model": None}
    return {embedding_column.key: embedding, "embedding_model": model}


async def _process_document_impl(document_id: UUID) -> DocumentDB | None:
    """Run the full processing pipeline once for a document.

    Raises on failure; the caller decides whether to retry (arq worker) or
    mark the document failed (synchronous fallback). Returns the document
    in its terminal state (READY, or FAILED when no text could be
    extracted) so callers can fire the matching webhook event in their own
    execution context — or None when the document no longer exists.
    ``document_id`` must already be a valid UUID.
    """
    db: Session = SessionLocal()
    try:
        repository = DocumentRepository(db)
        document = repository.get_by_id(document_id)

        if document is None:
            logger.error(f"Document not found: {document_id}")
            return

        repository.update_status(document_id, DocumentStatus.PROCESSING)
        _schedule_webhook(WebhookEvent.PROCESSING, document)

        file_content = storage.download(document.object_key)
        file_bytes = file_content.read()

        file_object = io.BytesIO(file_bytes)

        text_extraction = TextExtractionService()
        text = text_extraction.extract_text(
            file_object=file_object,
            mime_type=document.mime_type,
        )

        if not text.strip():
            document = repository.update_status(
                document_id,
                DocumentStatus.FAILED,
                error_message="No text content could be extracted",
            )
            _invalidate_caches(document)
            return document

        chunking = ChunkingService()
        chunks = chunking.chunk_text(text)

        embedding_service = EmbeddingService()

        # Generate embeddings for every chunk. This is best-effort:
        # if no embedding provider is configured (or the API call
        # fails, or the model returns a width other than the one
        # configured), we still save the chunks without vectors so the
        # document remains searchable via plain text search.
        embeddings: list[list[float] | None] = [None] * len(chunks)
        # The space and model the vectors belong to, or None when no provider is
        # configured. Read before the call so a failure cannot leave them
        # describing a vector that was never written.
        space = embedding_service.space
        model = embedding_service.model
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
            model = None

        from app.models.chunk import DocumentChunk, embedding_column_for

        # One column per embedding space, so a vector is written where the same
        # model's vectors can be found again. `embedding_column_for` raises for
        # an unknown space, which can only be a code error — and it is left to
        # propagate rather than silently writing nowhere.
        embedding_column = embedding_column_for(space) if space else None

        # A reprocess (or a retry after a partial commit) must not pile up
        # duplicate chunks: drop anything from a previous run first.
        db.query(DocumentChunk).filter(
            DocumentChunk.document_id == document_id
        ).delete(synchronize_session=False)

        # Bulk insert instead of per-chunk add()/flush: for large documents
        # this skips the unit-of-work machinery (identity map, dependency
        # tracking, per-object events) for thousands of rows. Order/indices
        # are preserved via chunk_index; the vector goes to its space's column
        # and `embedding_model` records which model produced it, so a later
        # search only ever compares vectors from the same model.
        db.bulk_save_objects(
            [
                DocumentChunk(
                    document_id=document_id,
                    content=chunk.content,
                    chunk_index=chunk.chunk_index,
                    metadata_=chunk.metadata,
                    **_vector_fields(chunk_embedding, embedding_column, model),
                )
                for chunk, chunk_embedding in zip(
                    chunks, embeddings, strict=False
                )
            ]
        )

        db.commit()

        # Visual thumbnails are strictly optional: a render or storage
        # failure must not fail the whole document (it stays READY, just
        # without a thumbnail).
        try:
            _generate_thumbnail(db, document, file_bytes)
        except Exception as e:  # noqa: BLE001 - thumbnails are best-effort
            logger.warning(f"Thumbnail generation failed for {document_id}: {e}")
            db.rollback()

        document = repository.update_status(document_id, DocumentStatus.READY)
        _invalidate_caches(document)
        logger.info(f"Document processed successfully: {document_id}")
        return document
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
        document = await _process_document_impl(document_uuid)
        if document is None:
            return
        # Terminal state reached (READY, or FAILED with no extractable
        # text): schedule the matching event. Runs in the worker's
        # long-lived loop, so the detached task completes.
        _schedule_webhook(
            (
                WebhookEvent.READY
                if document.status == DocumentStatus.READY
                else WebhookEvent.FAILED
            ),
            document,
        )
    except Exception as e:  # noqa: BLE001 - transient errors are retried
        job_try = int(ctx.get("job_try", 1))
        logger.error(
            f"Error processing document {document_uuid} "
            f"(try {job_try}/{MAX_RETRIES}): {e}"
        )
        if job_try >= MAX_RETRIES:
            # Final attempt exhausted — record the failure so the
            # document is never left stuck in a processing state. The
            # raw exception stays in the log; the persisted message is
            # generic so internal error details never reach the client.
            document = _mark_failed(
                document_uuid, "Document processing failed"
            )
            if document is not None:
                _schedule_webhook(WebhookEvent.FAILED, document)
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
        document = asyncio.run(_process_document_impl(document_id))
    except Exception as e:  # noqa: BLE001 - record the failure then re-raise
        logger.error(f"Synchronous processing failed for {document_id}: {e}")
        document = _mark_failed(document_id, str(e))
        if document is not None:
            # Sync context with no event loop: fire via a background thread.
            from app.services.webhook import (
                document_event_info,
                fire_webhook_background,
            )

            fire_webhook_background(
                WebhookEvent.FAILED.value,
                document_event_info(document),
            )
        raise
    else:
        # Terminal state reached: deliver the matching event without
        # blocking the caller (thread-based — safe outside an event loop).
        from app.services.webhook import (
            document_event_info,
            fire_webhook_background,
        )

        if document is not None:
            event = (
                WebhookEvent.READY
                if document.status == DocumentStatus.READY
                else WebhookEvent.FAILED
            )
            fire_webhook_background(event.value, document_event_info(document))


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


async def _worker_is_alive(redis) -> bool:
    """True when the arq worker's health-check heartbeat is fresh.

    Reuses the same key ``/v1/health`` and ``system_metrics.py`` read, so the
    recovery cron and the health endpoint can never disagree about liveness.

    Best-effort: a missing/unavailable Redis or an absent key reads as "not
    alive". That is the safe direction for this caller — treating an unknown
    worker as alive would risk re-enqueueing into a queue nobody is draining.
    """
    if redis is None:
        return False
    try:
        return bool(await redis.exists(WORKER_HEALTH_CHECK_KEY))
    except Exception as e:  # noqa: BLE001 - liveness is best-effort
        logger.debug(f"Worker liveness check failed: {e}")
        return False


async def _recover_stale_document(
    document: DocumentDB, redis, *, worker_alive: bool
) -> None:
    """Re-enqueue (bounded) or fail a single stale document.

    Split out of the sweep so the cron body only ever owns the query/commit
    while every Redis/enqueue side effect lives here.
    """
    # Without Redis we can neither read the worker's heartbeat nor track the
    # budget, and ``_enqueue_with_retry`` needs the same Redis. Re-enqueueing
    # anyway would be an unbounded retry loop, so keep the previous
    # fail-fast behaviour.
    if redis is None:
        _mark_stale_failed(document)
        return

    budget_key = f"{_STALE_RECOVER_KEY_PREFIX}{document.id}"
    try:
        attempts = await redis.incr(budget_key)
        if attempts == 1:
            await redis.expire(budget_key, STALE_RECOVER_COUNTER_TTL_SECONDS)
    except Exception as e:  # noqa: BLE001 - budget is best-effort
        # Cannot bound the retries, so do not start one: fail now.
        logger.warning(
            f"Stale-recovery budget unavailable for {document.id}: {e}"
        )
        _mark_stale_failed(document)
        return

    if attempts > STALE_RECOVER_MAX_ATTEMPTS:
        _mark_stale_failed(document)
        return

    try:
        await _enqueue_with_retry(document.id)
    except Exception as e:  # noqa: BLE001 - enqueue is best-effort
        logger.warning(f"Re-enqueue of stale document {document.id} failed: {e}")
        _mark_stale_failed(document)
        return

    # Intentionally leave status/error_message untouched: the re-enqueued job
    # owns them from here, and a successful run will flip the row to READY.
    logger.warning(
        f"Re-enqueued stale document {document.id} "
        f"(status={document.status.value}, worker_alive={worker_alive}, "
        f"attempt={attempts}/{STALE_RECOVER_MAX_ATTEMPTS})"
    )


def _mark_stale_failed(document: DocumentDB) -> None:
    """Fail a stale document that cannot be recovered."""
    logger.warning(
        f"Recovering stale document {document.id} "
        f"(status={document.status.value}, created={document.created_at})"
    )
    document.status = DocumentStatus.FAILED
    # A real recorded error (e.g. from a failed final retry) is more useful
    # than the generic timeout text, so only fill in the generic message when
    # the worker did not manage to record one.
    if not document.error_message:
        document.error_message = (
            "Processing did not complete within the timeout. "
            "The worker may have stopped, or a transient error "
            "exhausted the retries. Try reprocessing the document."
        )
    _invalidate_caches(document)
    _schedule_webhook(WebhookEvent.FAILED, document)


async def recover_stale_documents(ctx: dict) -> None:
    """Recover documents stuck in pending/processing.

    Runs periodically via the arq cron. Covers jobs that never started
    (enqueue failed/lost) or workers that crashed mid-flight.

    Historically this blindly marked every stale document FAILED, which
    meant a routine worker restart or deploy failed every in-flight upload
    even though the documents were fine. Recovery is now liveness-aware and
    re-enqueue-based:

    * The worker's arq health-check heartbeat is read first. When the worker
      is simply down the documents are not stuck, so they are re-enqueued for
      the next healthy worker instead of being failed.
    * Re-enqueues are bounded per document by a Redis counter, so a
      genuinely wedged document still lands in FAILED with a descriptive
      message instead of looping forever.
    * When the worker *is* alive, a wedged job is re-enqueued while budget
      remains; arq's own retry already covers transient failures, and the
      budget is what stops a permanent failure.
    """
    redis = ctx.get("redis")
    worker_alive = await _worker_is_alive(redis)

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
            await _recover_stale_document(
                document, redis=redis, worker_alive=worker_alive
            )
        if stale:
            db.commit()
            logger.info(
                f"Recovered {len(stale)} stale document(s) "
                f"(worker_alive={worker_alive})"
            )
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
    "job_timeout": WORKER_JOB_TIMEOUT_SECONDS,
    "health_check_key": WORKER_HEALTH_CHECK_KEY,
    "health_check_interval": WORKER_HEALTH_CHECK_INTERVAL,
    "on_startup": _worker_startup,
    "on_shutdown": _worker_shutdown,
}