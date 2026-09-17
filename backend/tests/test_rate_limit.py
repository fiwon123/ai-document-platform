"""Tests for the rate-limiting middleware (Redis path and fallback)."""

import time
from unittest.mock import MagicMock

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

    def test_forwarded_for_header_determines_client(self, monkeypatch):
        """Trust the first X-Forwarded-For entry when present (proxied deploys)."""
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1) as client:
            headers = {"X-Forwarded-For": "203.0.113.7, 10.0.0.1"}
            assert client.get("/", headers=headers).status_code == 200
            # Same real client behind the proxy is now at its limit...
            assert client.get("/", headers=headers).status_code == 429
            # ...while a different real client is unaffected.
            assert (
                client.get("/", headers={"X-Forwarded-For": "198.51.100.9, 10.0.0.1"}).status_code
                == 200
            )

    def test_memory_fallback_evicts_oldest_when_full(self, monkeypatch):
        """The in-memory map is bounded: oldest visitors are evicted first."""
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        monkeypatch.setattr(rate_limit, "_MEMORY_FALLBACK_MAX_ENTRIES", 3)
        with _make_client(requests=1) as client:
            for i in range(3):
                resp = client.get("/", headers={"X-Forwarded-For": f"10.0.0.{i}"})
                assert resp.status_code == 200

            # A fourth distinct IP pushes the oldest (10.0.0.0) out.
            resp = client.get("/", headers={"X-Forwarded-For": "10.0.0.4"})
            assert resp.status_code == 200

            # 10.0.0.0 was evicted, so it is treated as a fresh visitor...
            resp = client.get("/", headers={"X-Forwarded-For": "10.0.0.0"})
            assert resp.status_code == 200
            # ...but it is tracked again now, so its next request is limited.
            resp = client.get("/", headers={"X-Forwarded-For": "10.0.0.0"})
            assert resp.status_code == 429


class TestRedisPath:
    """Fixed-window limiter backed by Redis (mocked)."""

    def test_redis_path_limits_requests(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        # increment_with_ttl returns 1, 2, 3 for the three requests.
        increment_with_ttl = MagicMock(side_effect=[1, 2, 3])
        monkeypatch.setattr(redis_client, "increment_with_ttl", increment_with_ttl)

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

        assert increment_with_ttl.call_count == 3

    def test_redis_key_includes_client_ip(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        increment_with_ttl = MagicMock(return_value=1)
        monkeypatch.setattr(redis_client, "increment_with_ttl", increment_with_ttl)

        with _make_client() as client:
            client.get("/")

        assert increment_with_ttl.call_args.args[0].startswith("ratelimit:")

    def test_redis_path_uses_forwarded_for_ip(self, monkeypatch):
        """The Redis key must use the real client IP behind a proxy."""
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        increment_with_ttl = MagicMock(return_value=1)
        monkeypatch.setattr(redis_client, "increment_with_ttl", increment_with_ttl)

        with _make_client() as client:
            client.get("/", headers={"X-Forwarded-For": "203.0.113.7, 10.0.0.1"})

        assert increment_with_ttl.call_args.args[0] == "ratelimit:203.0.113.7"