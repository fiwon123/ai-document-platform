import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.cache import redis_client
from app.database.db import get_db
from app.storage.storage import storage

router = APIRouter(tags=["health"])

logger = logging.getLogger(__name__)


@router.get("/health")
def health_check(db: Annotated[Session, Depends(get_db)]):
    checks = {
        "status": "healthy",
        "services": {
            "database": check_database(db),
            "redis": check_redis(),
            "worker": check_worker(),
            "storage": check_storage(),
        },
    }

    all_healthy = all(
        service["status"] == "healthy"
        for service in checks["services"].values()
    )

    if not all_healthy:
        checks["status"] = "degraded"
        # Return 503 so orchestration (K8s probes, load balancers,
        # uptime monitors) can act on the degraded state.
        return JSONResponse(status_code=503, content=checks)

    return checks


def check_database(db: Session) -> dict:
    try:
        db.execute(text("SELECT 1"))
        return {"status": "healthy"}
    except Exception:
        # Log the real cause for operators; the external probe only needs
        # to know the dependency is down (never leak internals).
        logger.exception("Health check failed: database")
        return {"status": "unhealthy", "error": "Database check failed"}


def check_redis() -> dict:
    try:
        if redis_client.ping():
            return {"status": "healthy"}
        return {"status": "unhealthy", "error": "Ping failed"}
    except Exception:
        logger.exception("Health check failed: redis")
        return {"status": "unhealthy", "error": "Redis check failed"}


def check_worker() -> dict:
    """Report whether a document-processing worker is alive.

    The arq worker refreshes WORKER_HEALTH_CHECK_KEY in Redis every few
    seconds (see app.worker). A missing/expired key means no worker is
    consuming jobs — documents would stay pending until the stale
    recovery cron marks them failed.
    """
    try:
        from app.worker import WORKER_HEALTH_CHECK_KEY

        if redis_client.exists(WORKER_HEALTH_CHECK_KEY):
            return {"status": "healthy"}
        return {
            "status": "unhealthy",
            "error": "No worker heartbeat detected — document processing is unavailable",
        }
    except Exception:
        logger.exception("Health check failed: worker")
        return {"status": "unhealthy", "error": "Worker check failed"}


def check_storage() -> dict:
    try:
        storage.ensure_bucket()
        return {"status": "healthy"}
    except Exception:
        logger.exception("Health check failed: storage")
        return {"status": "unhealthy", "error": "Object storage check failed"}
