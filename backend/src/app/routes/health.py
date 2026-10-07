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

# A single table the application cannot function without. Probing for one known
# name is deliberately not an exhaustive schema check: `documents` or
# `refresh_sessions` could be absent while this one exists. What it does catch
# is the failure that matters at boot -- a database that has never been migrated,
# or whose tables were dropped -- which is the case where every request fails at
# once. Reporting an absent *any* table as healthy is what made #682 invisible.
REQUIRED_TABLE = "users"


@router.get("/health")
def health_check(db: Annotated[Session, Depends(get_db)]):
    """Liveness/readiness probe for the API and its dependencies.

    Checks PostgreSQL, Redis, the document-processing worker heartbeat, and
    object storage. Responds 200 ``healthy`` when every dependency is up, or
    503 ``degraded`` (with per-service errors) otherwise — orchestration and
    uptime monitors key off that status code.
    """
    checks = {
        "status": "healthy",
        "services": {
            "database": check_database(db),
            "redis": check_redis(),
            "worker": check_worker(),
            "storage": check_storage(),
        },
    }

    all_healthy = all(service["status"] == "healthy" for service in checks["services"].values())

    if not all_healthy:
        checks["status"] = "degraded"
        # Return 503 so orchestration (K8s probes, load balancers,
        # uptime monitors) can act on the degraded state.
        return JSONResponse(status_code=503, content=checks)

    return checks


def check_database(db: Session) -> dict:
    """Report whether the database is reachable *and* migrated.

    `SELECT 1` alone is not enough. It answers "is there a server?", and a live
    connection to an empty database answers that just as happily as a working
    one -- so a database whose tables are missing reads healthy here while every
    table-dependent request returns 500.

    That state is reachable in practice, not hypothetically: a stale
    ``alembic_version`` stamp alongside absent tables makes ``alembic upgrade
    head`` a no-op, so the entrypoint that exists to prevent a missing schema
    passes straight over it (#682). This endpoint is what K8s probes and load
    balancers key off, so a false "healthy" here means traffic is routed to an
    API that 500s on every authenticated request.

    So check for a table the app actually requires. ``to_regclass`` is a
    catalog lookup: cheap, and no error when the table is absent.
    """
    try:
        db.execute(text("SELECT 1"))
    except Exception:
        # Log the real cause for operators; the external probe only needs
        # to know the dependency is down (never leak internals).
        logger.exception("Health check failed: database")
        return {"status": "unhealthy", "error": "Database check failed"}

    try:
        present = db.execute(
            text("SELECT to_regclass(:table) IS NOT NULL"),
            {"table": REQUIRED_TABLE},
        ).scalar()
    except Exception:
        logger.exception("Health check failed: database schema probe")
        return {"status": "unhealthy", "error": "Database check failed"}

    if not present:
        # Not an error, so not logged as one: the database is up and answering,
        # it simply has no schema. Say so plainly -- an operator reading this
        # needs "run the migrations", and "Database check failed" sends them
        # looking at connectivity instead. No internals leak; the table name is
        # a fixed constant, not user input or configuration.
        logger.warning(
            "Health check: table %r is missing -- migrations have not been applied",
            REQUIRED_TABLE,
        )
        return {
            "status": "unhealthy",
            "error": "Database schema missing (migrations not applied)",
        }

    return {"status": "healthy"}


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
