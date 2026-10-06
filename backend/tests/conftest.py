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


def test_database_url() -> str:
    """Connection URL for the test database, as a URL not a bare name."""
    return f"postgresql://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{TEST_DB_NAME}"


# The database the application itself points at, captured before anything below
# overrides it. Recorded so the guard in _assert_test_database can refuse the
# case where the test database *is* the development one: TEST_DB_NAME=mydb
# satisfies a plain name comparison while still emptying real data. A second
# way to aim the suite at the wrong place, and the reason that comparison alone
# is not a sufficient check.
AMBIENT_POSTGRES_DB = os.getenv("POSTGRES_DB", "mydb")
AMBIENT_DATABASE_URL = os.getenv("DATABASE_URL")


def application_database_name() -> str:
    """Name of the database the app would use with no test override in place."""
    if AMBIENT_DATABASE_URL:
        try:
            return make_url(AMBIENT_DATABASE_URL).database or AMBIENT_POSTGRES_DB
        except Exception:  # noqa: BLE001 - a malformed URL is not this check's job
            return AMBIENT_POSTGRES_DB
    return AMBIENT_POSTGRES_DB


# App modules read environment variables at import time:
# - auth.py raises if SECRET_KEY is empty or is the published placeholder
# - database/db.py builds the engine from DATABASE_URL, falling back to POSTGRES_*
# Configure everything before any `app.*` import.
#
# DATABASE_URL is forced, and it is load-bearing: db.py:16 prefers it over the
# individual POSTGRES_* parts, so setting only POSTGRES_DB left the isolation
# below dead in any environment that exports DATABASE_URL. Inside the dev
# sandbox compose does exactly that, pointing at the *development* database --
# so create_all/drop_all ran against it and every full-suite run wiped the
# developer's data, silently, while still reporting green (#683).
#
# Forced, not setdefault, for the same reason as SECRET_KEY below: the value
# must come from the test configuration, never from whatever the ambient shell
# happens to export.
os.environ["DATABASE_URL"] = test_database_url()
# Kept in step so anything reading POSTGRES_DB directly still sees the test
# database rather than the ambient one.
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
from sqlalchemy.engine import make_url  # noqa: E402


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


def _assert_test_database(engine) -> None:
    """Refuse to run against anything but the test database.

    The suite calls ``create_all`` and ``drop_all`` on this engine, so pointing
    it at the wrong database is destructive and, until #683, silent: the run
    passed, the tables were gone, and the only symptom was a 500 on login some
    time later.

    This is the belt to the ``DATABASE_URL`` braces above. Setting the variable
    correctly is a claim about how ``db.py`` resolves its URL -- a claim that
    #664 already invalidated once, by making ``DATABASE_URL`` win over
    ``POSTGRES_*`` without updating this file. Checking the *connected*
    database instead of the configured one cannot go stale that way, because it
    tests the thing that actually matters rather than the thing that was set.
    """
    actual = engine.url.database
    if actual == TEST_DB_NAME:
        app_db = application_database_name()
        if app_db and actual == app_db:
            raise RuntimeError(
                f"Refusing to run: TEST_DB_NAME is {actual!r}, which is also the "
                f"database the application uses. This suite drops every table in "
                f"the database it connects to, so running it here would delete "
                f"real data. Set TEST_DB_NAME to a separate database."
            )
        return

    raise RuntimeError(
        f"Refusing to run: the test engine is bound to database {actual!r}, "
        f"expected {TEST_DB_NAME!r}. This suite drops every table in the "
        f"database it connects to, so running it here would delete real data. "
        f"Set TEST_DB_NAME to the intended test database."
    )


@pytest.fixture(scope="session")
def db_engine():
    """Engine bound to the test database; skips tests when PG is down."""
    try:
        _ensure_test_database()
    except Exception as exc:  # noqa: BLE001 - skip on any connectivity error
        pytest.skip(f"PostgreSQL not available: {exc}")

    from app.database.db import Base
    from app.database.db import engine as app_engine

    _assert_test_database(app_engine)

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
def isolate_secret_key_acknowledgement(monkeypatch):
    """Stop the signing-key guard tests from inheriting the dev sandbox's opt-in.

    ``ensure_secret_key_acceptable`` refuses every key this repository
    publishes, and the tests that assert it must therefore run with the
    bypass *off* -- otherwise they are not testing the guard, they are testing
    the environment. ``docker-compose.yaml`` sets
    ``ALLOW_PLACEHOLDER_SECRET_KEY=1`` on the dev and worker services on
    purpose (that sandbox is knowingly running with the published key), so
    inside the container five guard tests were red: green on a developer
    machine, red where the work actually happens (#534).

    Blank to "" -- *set*, not deleted, for the same reason as
    ``isolate_qa_model_env``: ``load_dotenv()`` (override=False) leaves an
    existing variable alone and would re-supply it from
    ``backend/src/app/.env``. An empty value is a real configuration here, not
    a missing one -- the guard documents that anything which is not truthy is
    treated as "not acknowledged". A test that needs the opt-in sets it with
    ``monkeypatch.setenv`` in its own body, which runs after this fixture, so
    the test always has the last word.
    """
    monkeypatch.setenv("ALLOW_PLACEHOLDER_SECRET_KEY", "")


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