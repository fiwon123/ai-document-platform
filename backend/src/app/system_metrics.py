"""Operational gauges backing the platform alerting rules (issue #316).

The monitoring-stack alert rules for worker liveness, stale documents and
Redis memory are only as good as the series they watch. These gauges are
exported by the backend ``/metrics`` endpoint (scraped by the ServiceMonitor)
and report their values at scrape time via ``set_function``, so the alert
rules stay simple and the gauges always reflect the live state:

- ``app_worker_up``             → WorkerDown
- ``app_documents_stale``       → WorkerStaleDocuments
- ``redis_memory_used_bytes``   → RedisMemoryHigh

Every callback is guarded: a temporarily unreachable dependency degrades to
a safe value instead of breaking the whole scrape.
"""

import logging
import os
from datetime import UTC, datetime, timedelta

from prometheus_client import Gauge
from sqlalchemy import func, select

from app.cache.redis import redis_client
from app.database.db import SessionLocal

logger = logging.getLogger(__name__)

# Documents stuck in pending/processing for longer than this are considered
# stale (the worker is not progressing past them). Tunable per deployment;
# must stay in sync with the WorkerStaleDocuments alert's intent.
STALE_DOCUMENT_AGE_MINUTES = int(os.getenv("STALE_DOCUMENT_AGE_MINUTES", "30"))

APP_WORKER_UP = Gauge(
    "app_worker_up",
    "1 when a document-processing worker heartbeat exists in Redis, 0 otherwise",
)
APP_DOCUMENTS_STALE = Gauge(
    "app_documents_stale",
    "Number of documents stuck in pending/processing beyond the stale threshold",
)
REDIS_MEMORY_USED_BYTES = Gauge(
    "redis_memory_used_bytes",
    "Redis used_memory in bytes (from INFO memory)",
)


def _worker_up() -> float:
    """1.0 when at least one arq worker refreshes its heartbeat key.

    The key lives in ``app.worker`` and mirrors the /v1/health check; it is
    imported lazily so importing this module never pulls in arq.
    """
    try:
        from app.worker import WORKER_HEALTH_CHECK_KEY

        return 1.0 if redis_client.exists(WORKER_HEALTH_CHECK_KEY) else 0.0
    except Exception:  # noqa: BLE001 - a broken dependency must not break /metrics
        logger.exception("Could not read worker heartbeat for metrics")
        return 0.0


def _stale_documents() -> float:
    """Count documents stuck in pending/processing past the threshold."""
    try:
        # Imported lazily: models import the Base from app.database.db, and
        # keeping startup imports light is a hard requirement here.
        from app.models.document import DocumentDB, DocumentStatus

        threshold = datetime.now(UTC) - timedelta(minutes=STALE_DOCUMENT_AGE_MINUTES)
        session = SessionLocal()
        try:
            count = session.scalar(
                select(func.count())
                .select_from(DocumentDB)
                .where(
                    DocumentDB.status.in_([DocumentStatus.PENDING, DocumentStatus.PROCESSING]),
                    DocumentDB.updated_at < threshold,
                )
            )
            return float(count or 0)
        finally:
            session.close()
    except Exception:  # noqa: BLE001
        logger.exception("Could not count stale documents for metrics")
        return 0.0


def _redis_memory_bytes() -> float:
    """Redis used_memory (bytes) from INFO memory; 0 when unreachable."""
    try:
        info = redis_client.client.info("memory")
        return float(info["used_memory"])
    except Exception:  # noqa: BLE001
        logger.exception("Could not read Redis memory for metrics")
        return 0.0


def _bind_system_metrics() -> None:
    """Point the gauges at the live read callbacks (evaluated on scrape)."""
    APP_WORKER_UP.set_function(_worker_up)
    APP_DOCUMENTS_STALE.set_function(_stale_documents)
    REDIS_MEMORY_USED_BYTES.set_function(_redis_memory_bytes)


_bind_system_metrics()
