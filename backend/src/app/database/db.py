import os
from collections.abc import Generator

from dotenv import load_dotenv
from prometheus_client import Gauge
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

load_dotenv()

db_name = os.getenv("POSTGRES_DB", "mydb")
db_user = os.getenv("POSTGRES_USER", "postgres")
db_password = os.getenv("POSTGRES_PASSWORD")
db_port = os.getenv("POSTGRES_PORT", "5432")
db_host = os.getenv("POSTGRES_HOST", "localhost")

if not db_password:
    # No baked-in default: a silently-used placeholder password is a
    # security footgun. Fail fast with a clear message instead.
    raise RuntimeError(
        "POSTGRES_PASSWORD environment variable must be set "
        "(no default is provided — configure it via the environment or .env)"
    )

SQLALCHEMY_DATABASE_URL = (
    f"postgresql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"
)

# Connection-pool tuning, all env-configurable so operators can size the pool
# per deployment without a code change. Defaults match the previous
# hardcoded values, except pool_recycle (now 30 min instead of "never": it
# prevents serving stale server-side connections after Postgres restarts).
DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "5"))
DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "10"))
DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30"))
_DB_POOL_RECYCLE_RAW = os.getenv("DB_POOL_RECYCLE", "1800").strip().lower()
# Accept 0 / -1 / "none" / "" as "no recycle" for SQLAlchemy-null semantics.
DB_POOL_RECYCLE = (
    None
    if _DB_POOL_RECYCLE_RAW in {"", "0", "-1", "none"}
    else int(_DB_POOL_RECYCLE_RAW)
)

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_pre_ping=True,
    pool_size=DB_POOL_SIZE,
    max_overflow=DB_MAX_OVERFLOW,
    pool_timeout=DB_POOL_TIMEOUT,
    pool_recycle=DB_POOL_RECYCLE,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# ---------------------------------------------------------------------------
# Connection-pool metrics (exposed on /metrics, scraped by the monitoring
# stack). Implemented with ``set_function``: each gauge reports the pool's
# live value at scrape time, so there is no event bookkeeping to drift.
# ---------------------------------------------------------------------------
POOL_CHECKED_IN = Gauge(
    "pool_checked_in",
    "SQLAlchemy connections currently checked in to the pool (idle)",
)
POOL_CHECKED_OUT = Gauge(
    "pool_checked_out",
    "SQLAlchemy connections currently checked out (in use by requests)",
)
POOL_OVERFLOW = Gauge(
    "pool_overflow",
    "SQLAlchemy overflow connections currently in use (over pool_size)",
)


def _bind_pool_metrics(bind_engine) -> None:
    """Point the pool gauges at the live QueuePool state."""
    pool = bind_engine.pool
    POOL_CHECKED_IN.set_function(pool.checkedin)
    POOL_CHECKED_OUT.set_function(pool.checkedout)
    POOL_OVERFLOW.set_function(pool.overflow)


_bind_pool_metrics(engine)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
