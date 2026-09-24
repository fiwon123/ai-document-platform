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