"""Prometheus /metrics endpoint tests."""


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