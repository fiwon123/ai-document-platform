"""Shared pytest fixtures for the backend test suite.

Database-backed tests use a dedicated PostgreSQL test database
(``mydb_test`` by default). If PostgreSQL is not reachable, those tests
are skipped automatically so unit tests (which mock repositories and
external services) still run anywhere.

External services (OpenAI, MinIO) must always be mocked in tests.
"""

import os
import uuid

import pytest

TEST_DB_NAME = os.getenv("TEST_DB_NAME", "mydb_test")
PG_HOST = os.getenv("POSTGRES_HOST", "localhost")
PG_PORT = os.getenv("POSTGRES_PORT", "5432")
PG_USER = os.getenv("POSTGRES_USER", "postgres")
PG_PASSWORD = os.getenv("POSTGRES_PASSWORD", "mysecretpassword")

# App modules read environment variables at import time:
# - auth.py raises if SECRET_KEY is empty or is the published placeholder
# - database/db.py builds the engine from POSTGRES_* vars
# Configure everything before any `app.*` import.
os.environ["POSTGRES_DB"] = TEST_DB_NAME
# The app engine requires POSTGRES_PASSWORD (no default is baked in
# anymore); align it with the maintenance-connection password so the
# suite runs without extra environment configuration.
os.environ.setdefault("POSTGRES_PASSWORD", PG_PASSWORD)
# Forced, not setdefault: a developer shell that exports the project's
# placeholder SECRET_KEY (the docker-compose default) would otherwise leak into
# the suite and trip the startup guard in app/config.py, failing every test that
# imports app.routes.auth. The suite must not depend on ambient configuration.
os.environ["SECRET_KEY"] = "test-only-secret-key"
# Keep the in-memory rate limiter from tripping during long test runs.
os.environ.setdefault("RATE_LIMIT_REQUESTS", "10000")
# httpx (TestClient) never sends Secure cookies over plain http:// — disable
# the Secure flag in tests so the refresh-cookie flow is exercised end-to-end.
os.environ.setdefault("REFRESH_COOKIE_SECURE", "false")
# Run against a dedicated Redis database so the autouse flush fixture can
# fully isolate tests from the development cache (and from each other).
# Forced (not setdefault) so a stray REDIS_DB in the environment cannot
# point the flush at the developer's live cache database.
os.environ["REDIS_DB"] = "15"

# NOTE: imports must stay below the env setup above — app modules read
# the environment at import time.
from sqlalchemy import create_engine, text  # noqa: E402


def _server_engine():
    """Engine that connects to the PostgreSQL maintenance database."""
    return create_engine(
        f"postgresql://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/postgres",
    )


def _ensure_test_database() -> None:
    """Create the test database if it does not exist yet."""
    engine = _server_engine()
    try:
        with engine.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :name"),
                {"name": TEST_DB_NAME},
            ).scalar()
            if not exists:
                conn.execute(text("COMMIT"))
                conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    finally:
        engine.dispose()


@pytest.fixture(scope="session")
def db_engine():
    """Engine bound to the test database; skips tests when PG is down."""
    try:
        _ensure_test_database()
    except Exception as exc:  # noqa: BLE001 - skip on any connectivity error
        pytest.skip(f"PostgreSQL not available: {exc}")

    from app.database.db import Base
    from app.database.db import engine as app_engine

    with app_engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.execute(text("COMMIT"))

    # Importing models registers them with Base.metadata.
    import app.models  # noqa: F401

    Base.metadata.create_all(app_engine)

    yield app_engine

    Base.metadata.drop_all(app_engine)
    app_engine.dispose()


def _truncate_all(engine) -> None:
    from app.database.db import Base

    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(table.delete())


@pytest.fixture(autouse=True)
def isolate_qa_model_env(monkeypatch):
    """Stop QA tests from inheriting the developer's model selection.

    ``resolve_default_model()`` reads ``QA_MODEL`` and ``OPENAI_MODEL`` live
    from the environment on every call, by design so a config change applies
    without a restart. That makes it the one piece of configuration a test
    cannot control by patching a module attribute, and it meant any test which
    called ``ask()`` without naming a model had its provider picked by whatever
    the machine happened to export: ``QA_MODEL=llama-3.3-70b-versatile`` in a
    developer's shell made the "local provider" and BYOK tests resolve to Groq
    and fail on a suite that was green in CI.

    Both are blanked to "" -- *set*, not deleted, because ``load_dotenv()``
    (override=False) leaves an existing variable alone and would otherwise
    re-supply them from ``backend/src/app/.env``. A test that needs one of
    them sets it with ``monkeypatch.setenv`` in its own body, which runs after
    this fixture, so the test always has the last word.

    The import-time provider clients are a separate concern, handled per-test
    by ``_patch_llm_client`` (see #478).
    """
    monkeypatch.setenv("QA_MODEL", "")
    monkeypatch.setenv("OPENAI_MODEL", "")


@pytest.fixture(autouse=True)
def flush_test_redis():
    """Wipe the dedicated test Redis database before every test.

    Caching tests that do not use the in-memory ``fake_redis`` fixture
    (e.g. statistics route tests) must never observe keys left behind by
    an earlier test. When Redis is unreachable this is a no-op — the
    caching code paths already fall back gracefully.
    """
    from app.cache.redis import redis_client

    try:
        redis_client.client.flushdb()
    except Exception:  # noqa: BLE001, S110 - Redis is optional in tests
        pass
    yield


@pytest.fixture()
def db_session(db_engine):
    """Function-scoped SQLAlchemy session with a clean database."""
    _truncate_all(db_engine)

    from app.database.db import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def clean_db(db_engine):
    """Truncate all tables before a test that manages its own sessions."""
    _truncate_all(db_engine)
    yield


@pytest.fixture()
def client(db_session):
    """FastAPI TestClient with get_db overridden to the test session."""
    from fastapi.testclient import TestClient

    from app.database.db import get_db
    from app.main import app

    def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def auth_headers(client):
    """Register + login a unique test user and return Bearer headers."""
    username = f"user_{uuid.uuid4().hex[:10]}"
    password = "testpass123"

    register = client.post(
        "/v1/auth/register",
        json={
            "username": username,
            "password": password,
            "confirm_password": password,
        },
    )
    assert register.status_code == 201, register.text

    login = client.post(
        "/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert login.status_code == 200, login.text

    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def pdf_bytes() -> bytes:
    """A real, valid PDF built in memory (used by thumbnail rendering tests).

    PyMuPDF is a hard dependency, so importing it here is safe; no external
    services or fixture files are involved.
    """
    import fitz

    document = fitz.open()
    try:
        page = document.new_page()
        page.insert_text((72, 72), "Hello thumbnail")
        return document.tobytes()
    finally:
        document.close()