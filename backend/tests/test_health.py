"""Health endpoint tests: /v1/health must signal degradation to
orchestration (K8s probes) via a non-2xx status code."""

from unittest.mock import MagicMock


def test_health_healthy(client, monkeypatch):
    """All services healthy -> 200 with status 'healthy'."""
    import app.routes.health as hr

    monkeypatch.setattr(hr, "check_database", lambda db: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_redis", lambda: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_worker", lambda: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_storage", lambda: {"status": "healthy"})

    resp = client.get("/v1/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["services"]["database"]["status"] == "healthy"


def test_health_degraded_returns_503(client, monkeypatch):
    """Any unhealthy dependency -> 503 so probes/LB can react."""
    import app.routes.health as hr

    monkeypatch.setattr(hr, "check_database", lambda db: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_redis", lambda: {"status": "unhealthy", "error": "boom"})
    monkeypatch.setattr(hr, "check_worker", lambda: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_storage", lambda: {"status": "healthy"})

    resp = client.get("/v1/health")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["services"]["redis"]["status"] == "unhealthy"


def test_check_functions_sanitize_internal_errors(monkeypatch):
    """The real check functions never leak exception internals to the
    response — the cause goes to the log, the payload stays generic."""
    from app.routes import health as hr

    class Boom(Exception):
        pass

    # Silences the traceback logging while asserting the log line fires.
    logger_mock = MagicMock()
    monkeypatch.setattr(hr, "logger", logger_mock)

    def raise_secretive(message: str):
        def _raise(*_args, **_kwargs):
            raise Boom(
                f"{message} (connection to 10.0.0.7:5432 failed with "
                "password authentication error)"
            )

        return _raise

    monkeypatch.setattr(
        hr.redis_client, "ping", raise_secretive("redis down")
    )
    redis_result = hr.check_redis()
    assert redis_result["error"] == "Redis check failed"
    assert "10.0.0.7" not in str(redis_result)

    monkeypatch.setattr(
        hr.storage, "ensure_bucket", raise_secretive("minio down")
    )
    storage_result = hr.check_storage()
    assert storage_result["error"] == "Object storage check failed"
    assert "10.0.0.7" not in str(storage_result)

    db_session = MagicMock()
    monkeypatch.setattr(
        db_session, "execute", raise_secretive("postgres down")
    )
    database_result = hr.check_database(db_session)
    assert database_result["error"] == "Database check failed"
    assert "10.0.0.7" not in str(database_result)

    assert logger_mock.exception.call_count == 3


# --- #682: a reachable database with no schema is not healthy --------------
#
# `SELECT 1` succeeds against an empty database, so the original check reported
# "healthy" for a server that had no tables at all -- while every
# table-dependent request returned 500. These tests pin the corrected
# behaviour, and the last one deliberately builds the real failing state rather
# than mocking it: a guard that has only ever been seen to pass is untested.


def _schema_session(*, table_present: bool):
    """A session whose connectivity succeeds but whose schema is absent/present.

    Distinguishes the two statements by SQL text: `SELECT 1` always succeeds,
    the `to_regclass` probe returns the configured answer.
    """
    session = MagicMock()

    def _execute(statement, *args, **kwargs):
        sql = str(statement)
        if "to_regclass" in sql:
            result = MagicMock()
            result.scalar.return_value = table_present
            return result
        result = MagicMock()
        result.scalar.return_value = 1
        return result

    session.execute.side_effect = _execute
    return session


def test_check_database_unhealthy_when_schema_missing(monkeypatch):
    """Reachable database, no `users` table -> unhealthy, not healthy."""
    from app.routes import health as hr

    logger_mock = MagicMock()
    monkeypatch.setattr(hr, "logger", logger_mock)

    result = hr.check_database(_schema_session(table_present=False))

    assert result["status"] == "unhealthy"
    # The message has to tell an operator what to *do*; "Database check failed"
    # sends them to investigate connectivity instead.
    assert "migration" in result["error"].lower()


def test_check_database_healthy_when_schema_present(monkeypatch):
    """No regression: a migrated database is still healthy."""
    from app.routes import health as hr

    result = hr.check_database(_schema_session(table_present=True))

    assert result == {"status": "healthy"}


def test_check_database_unhealthy_when_schema_probe_itself_errors(monkeypatch):
    """A failing schema probe is unhealthy, never silently healthy."""
    from app.routes import health as hr

    logger_mock = MagicMock()
    monkeypatch.setattr(hr, "logger", logger_mock)

    session = MagicMock()

    def _execute(statement, *args, **kwargs):
        if "to_regclass" in str(statement):
            raise RuntimeError("catalog lookup failed")
        result = MagicMock()
        result.scalar.return_value = 1
        return result

    session.execute.side_effect = _execute

    result = hr.check_database(session)

    assert result["status"] == "unhealthy"
    assert result["error"] == "Database check failed"
    assert "catalog lookup failed" not in str(result)
    assert logger_mock.exception.call_count == 1


def test_health_returns_503_when_schema_missing(client, monkeypatch):
    """End-to-end: the probe reports degraded, so orchestrators stop routing."""
    import app.routes.health as hr

    monkeypatch.setattr(hr, "check_database", lambda db: {
        "status": "unhealthy",
        "error": "Database schema missing (migrations not applied)",
    })
    monkeypatch.setattr(hr, "check_redis", lambda: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_worker", lambda: {"status": "healthy"})
    monkeypatch.setattr(hr, "check_storage", lambda: {"status": "healthy"})

    resp = client.get("/v1/health")

    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["services"]["database"]["status"] == "unhealthy"


def test_health_probe_fails_when_schema_actually_absent(db_session, monkeypatch):
    """The real check against a database genuinely missing its schema.

    Every other test here mocks `check_database`, which cannot catch the check
    itself being wrong -- the failure mode of #638, #673, #671 and #678, all
    gates that never fired. So this drops the application's own table and asks
    the real `check_database` to notice.

    The table is restored afterwards: `db_session` yields a live session on the
    shared test database, and leaving it dropped would turn every later
    database-backed test in the run into a `UndefinedTable` error.
    """
    from sqlalchemy import text

    from app.routes import health as hr

    db_session.execute(text("ALTER TABLE users RENAME TO users__healthcheck_backup"))
    try:
        result = hr.check_database(db_session)
        assert result["status"] == "unhealthy", (
            "check_database reported healthy for a database with no users table -- "
            "this is exactly the #682 failure"
        )
        assert "migration" in result["error"].lower()
    finally:
        # No rollback here: it would undo the rename above, and the restore
        # would then target a table that no longer exists. Both statements share
        # one transaction, so renaming back inside `finally` is what leaves the
        # database as it was found.
        db_session.execute(text("ALTER TABLE users__healthcheck_backup RENAME TO users"))
        db_session.commit()