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


class TestClientIp:
    """Rate limiting must key on the real client behind a trusted proxy."""

    def test_uses_rightmost_x_forwarded_for_with_redis(self, monkeypatch):
        """An appending proxy puts the address it saw last, so that is the entry
        the client cannot choose and therefore the one that identifies it."""
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: True)
        increment = MagicMock(return_value=1)
        monkeypatch.setattr(redis_client, "increment", increment)
        monkeypatch.setattr(redis_client.client, "expire", MagicMock())

        with _make_client() as client:
            client.get("/", headers={"X-Forwarded-For": "203.0.113.9, 10.0.0.1"})

        # 10.0.0.1 is the entry the proxy appended; 203.0.113.9 is the client's.
        assert increment.call_args.args[0] == "ratelimit:10.0.0.1"

    def test_spoofed_leftmost_entry_cannot_mint_a_fresh_bucket(self, monkeypatch):
        """Regression: rotating a prepended entry must not escape the limiter.

        This is what nginx's ``$proxy_add_x_forwarded_for`` produces -- the
        client's own value first, the address nginx saw appended after it. Reading
        the leftmost entry let every request land in a new bucket, so the limiter
        never fired at all.
        """
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        real_client = "198.51.100.1"
        with _make_client(requests=3, window=60) as client:
            codes = [
                client.get(
                    "/", headers={"X-Forwarded-For": f"203.0.113.{i}, {real_client}"}
                ).status_code
                for i in range(10)
            ]

        # The real client is the same throughout, so the limit must bite.
        assert codes[:3] == [200, 200, 200]
        assert codes[3:] == [429] * 7

    def test_distinct_clients_still_get_distinct_buckets(self, monkeypatch):
        """Reading the rightmost entry must not merge genuinely different
        clients into one bucket."""
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1, window=60) as client:
            # Same spoofed prefix, different real clients.
            for real_client in ("198.51.100.1", "198.51.100.2"):
                assert (
                    client.get(
                        "/", headers={"X-Forwarded-For": f"203.0.113.9, {real_client}"}
                    ).status_code
                    == 200
                )
            # Each is now over its own limit.
            for real_client in ("198.51.100.1", "198.51.100.2"):
                assert (
                    client.get(
                        "/", headers={"X-Forwarded-For": f"203.0.113.9, {real_client}"}
                    ).status_code
                    == 429
                )

    def test_overlong_forwarded_entry_is_ignored(self, monkeypatch):
        """A junk final entry is not an IP, so it must not be trusted as one."""
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1, window=60) as client:
            # Falls back to the socket peer, so the limit still applies.
            assert client.get("/").status_code == 200
            junk = "x" * (rate_limit._MAX_FORWARDED_TOKEN_LENGTH + 1)
            assert (
                client.get("/", headers={"X-Forwarded-For": f"203.0.113.9, {junk}"}).status_code
                == 429
            )

    def test_xff_ignored_by_default(self, monkeypatch):
        """Without TRUST_PROXY_HEADERS a client cannot spoof its way past
        the limiter by rotating X-Forwarded-For."""
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", False)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1, window=60) as client:
            assert (
                client.get("/", headers={"X-Forwarded-For": "203.0.113.9"}).status_code
                == 200
            )
            # Same socket peer, different spoofed header: still limited.
            assert (
                client.get("/", headers={"X-Forwarded-For": "198.51.100.7"}).status_code
                == 429
            )

    def test_fallback_uses_socket_peer_without_xff(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1, window=60) as client:
            assert client.get("/").status_code == 200
            assert client.get("/").status_code == 429

    def test_fallback_buckets_by_xff_ip(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        with _make_client(requests=1, window=60) as client:
            assert (
                client.get("/", headers={"X-Forwarded-For": "203.0.113.9"}).status_code
                == 200
            )
            assert (
                client.get("/", headers={"X-Forwarded-For": "203.0.113.9"}).status_code
                == 429
            )
            # A different forwarded client must get its own bucket.
            assert (
                client.get("/", headers={"X-Forwarded-For": "198.51.100.7"}).status_code
                == 200
            )

    def test_fallback_bounded_eviction(self, monkeypatch):
        monkeypatch.setattr(rate_limit, "TRUST_PROXY_HEADERS", True)
        monkeypatch.setattr(rate_limit, "_redis_is_available", lambda: False)
        monkeypatch.setattr(rate_limit, "MAX_IN_MEMORY_CLIENTS", 3)
        with _make_client(requests=1, window=60) as client:
            for forwarded in ("10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"):
                assert (
                    client.get("/", headers={"X-Forwarded-For": forwarded}).status_code
                    == 200
                )
            # Inserting the 4th bucket evicted the oldest (10.0.0.1), so the
            # first forwarded IP is no longer rate-limited.
            assert (
                client.get("/", headers={"X-Forwarded-For": "10.0.0.1"}).status_code
                == 200
            )