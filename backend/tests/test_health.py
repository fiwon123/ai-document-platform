"""Health endpoint tests: /v1/health must signal degradation to
orchestration (K8s probes) via a non-2xx status code."""


def test_health_healthy(client):
    """All services healthy -> 200 with status 'healthy'."""
    from app.routes import health as health_route

    import app.routes.health as hr

    hr.check_database = lambda db: {"status": "healthy"}
    hr.check_redis = lambda: {"status": "healthy"}
    hr.check_worker = lambda: {"status": "healthy"}
    hr.check_storage = lambda: {"status": "healthy"}

    resp = client.get("/v1/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["services"]["database"]["status"] == "healthy"

    # Restore the real implementations for other tests.
    hr.check_database = health_route.check_database
    hr.check_redis = health_route.check_redis
    hr.check_worker = health_route.check_worker
    hr.check_storage = health_route.check_storage


def test_health_degraded_returns_503(client):
    """Any unhealthy dependency -> 503 so probes/LB can react."""
    from app.routes import health as health_route

    import app.routes.health as hr

    hr.check_database = lambda db: {"status": "healthy"}
    hr.check_redis = lambda: {"status": "unhealthy", "error": "boom"}
    hr.check_worker = lambda: {"status": "healthy"}
    hr.check_storage = lambda: {"status": "healthy"}

    resp = client.get("/v1/health")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["services"]["redis"]["status"] == "unhealthy"

    # Restore the real implementations for other tests.
    hr.check_database = health_route.check_database
    hr.check_redis = health_route.check_redis
    hr.check_worker = health_route.check_worker
    hr.check_storage = health_route.check_storage