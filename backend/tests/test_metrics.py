"""Prometheus /metrics endpoint tests."""

import pytest

_HEALTH_CHECKS = ("check_database", "check_redis", "check_worker", "check_storage")


@pytest.fixture(autouse=True)
def _healthy_health_checks():
    """Force the health checks healthy so the metric tests do not depend
    on infra liveness.

    The real ``check_worker`` reports unhealthy whenever the arq worker
    heartbeat key is missing (no worker runs in the test/CI environment),
    which would make ``/v1/health`` return 503 and fail this suite's
    precondition — irrelevant to what these tests exercise.
    """
    import app.routes.health as hr

    original = {name: getattr(hr, name) for name in _HEALTH_CHECKS}
    for name in original:
        setattr(hr, name, lambda *a, **k: {"status": "healthy"})
    yield
    for name, fn in original.items():
        setattr(hr, name, fn)


def test_metrics_endpoint_exposes_process_and_http_metrics(client):
    """The scrape endpoint returns process + HTTP metrics in text format."""
    # Hit an endpoint first so the HTTP counters have data.
    resp = client.get("/v1/health")
    assert resp.status_code == 200

    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")

    body = resp.text
    assert "python_info" in body
    assert "http_requests_total" in body
    assert "http_request_duration_seconds" in body


def test_metrics_uses_normalized_path_labels(client):
    """Variable path segments collapse to {id} to bound cardinality."""
    client.get("/v1/health")
    client.get("/v1/documents/00000000-0000-0000-0000-000000000000")

    body = client.get("/metrics").text
    assert 'path="/v1/health"' in body
    assert 'path="/v1/documents/{id}"' in body
    assert "00000000-0000-0000-0000-000000000000" not in body


def test_metrics_endpoint_is_not_instrumented(client):
    """Scrape requests must not pollute the metrics they expose."""
    client.get("/metrics")
    client.get("/metrics")

    body = client.get("/metrics").text
    assert 'path="/metrics"' not in body


def test_metrics_expose_database_pool_gauges(client):
    """The SQLAlchemy connection pool publishes checked_in/out/overflow."""
    # Hitting an endpoint that uses get_db exercises the pool lifecycle.
    resp = client.get("/v1/health")
    assert resp.status_code == 200

    body = client.get("/metrics").text
    assert "pool_checked_in" in body
    assert "pool_checked_out" in body
    assert "pool_overflow" in body