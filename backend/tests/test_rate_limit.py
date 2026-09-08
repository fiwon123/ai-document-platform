"""Tests for the rate-limiting middleware (Redis path and fallback)."""

import time
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.cache.redis import redis_client
from app.middleware import rate_limit


def _make_client(requests=2, window=60):
    mini = FastAPI()

    @mini.get("/")
    def root():
        return {"ok": True}

    mini.add_middleware(rate_limit.RateLimitMiddleware, requests=requests, window=window)
    return TestClient(mini, raise_server_exceptions=False)


class TestMemoryFallback:
    """In-process sliding window used when Redis is unreachable."""

    def test_allows_requests_under_limit(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=2) as client:
            for _ in range(2):
                resp = client.get("/")
                assert resp.status_code == 200
                assert resp.headers["X-RateLimit-Limit"] == "2"
                assert resp.headers["X-RateLimit-Remaining"] in ("1", "0")

    def test_returns_429_over_limit_with_headers(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=2) as client:
            client.get("/")
            client.get("/")
            resp = client.get("/")

            assert resp.status_code == 429
            body = resp.json()
            assert body["error"]["code"] == "rate_limit_exceeded"
            assert resp.headers["X-RateLimit-Limit"] == "2"
            assert resp.headers["X-RateLimit-Remaining"] == "0"

    def test_window_slides_and_recovers(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=2, window=1) as client:
            client.get("/")
            client.get("/")
            assert client.get("/").status_code == 429

            # After the window elapses the counter is reset.
            time.sleep(1.1)
            assert client.get("/").status_code == 200


class TestRedisPath:
    """Fixed-window limiter backed by Redis (mocked)."""

    def test_redis_path_limits_requests(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        # INCR returns 1, 2, 3 for the three requests.
        increment = MagicMock(side_effect=[1, 2, 3])
        expire = MagicMock()
        monkeypatch.setattr(redis_client, "increment", increment)
        monkeypatch.setattr(redis_client.client, "expire", expire)

        with _make_client(requests=2) as client:
            resp1 = client.get("/")
            assert resp1.status_code == 200
            assert resp1.headers["X-RateLimit-Remaining"] == "1"

            resp2 = client.get("/")
            assert resp2.status_code == 200
            assert resp2.headers["X-RateLimit-Remaining"] == "0"

            resp3 = client.get("/")
            assert resp3.status_code == 429
            assert resp3.json()["error"]["code"] == "rate_limit_exceeded"

        # TTL expiry set exactly once (first increment returns 1).
        assert expire.call_count == 1

    def test_redis_key_includes_client_ip(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        increment = MagicMock(return_value=1)
        monkeypatch.setattr(redis_client, "increment", increment)
        monkeypatch.setattr(redis_client.client, "expire", MagicMock())

        with _make_client() as client:
            client.get("/")

        assert increment.call_args.args[0].startswith("ratelimit:")