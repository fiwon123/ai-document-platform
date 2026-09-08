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
# - auth.py raises if SECRET_KEY is empty
# - database/db.py builds the engine from POSTGRES_* vars
# Configure everything before any `app.*` import.
os.environ["POSTGRES_DB"] = TEST_DB_NAME
os.environ.setdefault("SECRET_KEY", "test-only-secret-key")

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
    except Exception as exc:  # pragma: no cover - environment dependent
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