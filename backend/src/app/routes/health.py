from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.cache import redis_client
from app.database.db import get_db
from app.storage.storage import storage

router = APIRouter(tags=["health"])


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

    return checks


def check_database(db: Session) -> dict:
    try:
        db.execute(text("SELECT 1"))
        return {"status": "healthy"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


def check_redis() -> dict:
    try:
        if redis_client.ping():
            return {"status": "healthy"}
        return {"status": "unhealthy", "error": "Ping failed"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


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
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}


def check_storage() -> dict:
    try:
        storage.ensure_bucket()
        return {"status": "healthy"}
    except Exception as e:
        return {"status": "unhealthy", "error": str(e)}
