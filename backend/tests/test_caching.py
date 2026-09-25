"""Tests for the ETag/Cache-Control middleware (app/middleware/caching.py).

Unit tests run the middleware against a tiny throwaway FastAPI app so the
policy table (path → Cache-Control/ETag/Vary, conditional-GET handling) is
verified without a database or external services. The integration tests
request the real app to prove the full middleware chain keeps the headers
and passes non-listed routes through unmodified.
"""

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.middleware.caching import ETagCacheMiddleware

THUMBNAIL_PATH = "/v1/documents/00000000-0000-0000-0000-000000000000/thumbnail"


def _mini_app() -> FastAPI:
    """A minimal app that mirrors the three cached routes plus a control."""
    app = FastAPI()

    @app.get("/v1/qa/models")
    def models():
        return {"models": [{"id": "gpt-4", "tier": "default"}]}

    @app.get("/v1/statistics/me")
    def stats():
        return {"total_documents": 3, "total_chunks": 12}

    @app.get(THUMBNAIL_PATH)
    def thumb():
        return {"thumbnail_url": "https://storage.example/thumb.png?X-Amz-Signature=abc"}

    @app.get("/v1/other")
    def other():
        return {"ok": True}

    app.add_middleware(ETagCacheMiddleware)
    return app


@pytest.fixture()
def mini_client():
    with TestClient(_mini_app()) as client:
        yield client


class TestModelsPolicy:
    def test_public_immutable_cache_control(self, mini_client):
        resp = mini_client.get("/v1/qa/models")

        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "public, max-age=3600, immutable"
        # Strong ETag (no W/ prefix) for byte-identical content.
        assert resp.headers["etag"].startswith('"')
        assert not resp.headers["etag"].startswith("W/")
        assert "vary" not in resp.headers

    def test_matching_if_none_match_returns_304(self, mini_client):
        etag = mini_client.get("/v1/qa/models").headers["etag"]

        resp = mini_client.get("/v1/qa/models", headers={"If-None-Match": etag})

        assert resp.status_code == 304
        assert resp.content == b""
        assert resp.headers["etag"] == etag
        assert resp.headers["cache-control"] == "public, max-age=3600, immutable"

    def test_stale_if_none_match_returns_fresh_200(self, mini_client):
        resp = mini_client.get("/v1/qa/models", headers={"If-None-Match": '"stale"'})

        assert resp.status_code == 200
        assert resp.headers["etag"] != '"stale"'
        assert resp.json()["models"][0]["id"] == "gpt-4"


class TestStatisticsPolicy:
    def test_private_short_ttl_with_vary(self, mini_client):
        resp = mini_client.get("/v1/statistics/me")

        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "private, max-age=60"
        # Weak ETag: the body may legitimately change between generations.
        assert resp.headers["etag"].startswith('W/"')
        assert resp.headers["vary"] == "Authorization"

    def test_304_preserves_private_policy_headers(self, mini_client):
        etag = mini_client.get("/v1/statistics/me").headers["etag"]

        resp = mini_client.get(
            "/v1/statistics/me", headers={"If-None-Match": etag}
        )

        assert resp.status_code == 304
        assert resp.headers["cache-control"] == "private, max-age=60"
        assert resp.headers["vary"] == "Authorization"


class TestThumbnailPolicy:
    def test_private_capped_ttl_with_vary(self, mini_client):
        resp = mini_client.get(THUMBNAIL_PATH)

        assert resp.status_code == 200
        # TTL capped below the 1 h presign validity so a cached URL is
        # always still valid when a client reuses it.
        assert resp.headers["cache-control"] == "private, max-age=900"
        assert resp.headers["etag"].startswith('"')
        assert resp.headers["vary"] == "Authorization"

    def test_304_serves_cached_thumbnail_url(self, mini_client):
        etag = mini_client.get(THUMBNAIL_PATH).headers["etag"]

        resp = mini_client.get(THUMBNAIL_PATH, headers={"If-None-Match": etag})

        assert resp.status_code == 304
        assert resp.headers["etag"] == etag


class TestPassThrough:
    def test_unlisted_path_is_not_tagged(self, mini_client):
        resp = mini_client.get("/v1/other")

        assert resp.status_code == 200
        assert "cache-control" not in resp.headers
        assert "etag" not in resp.headers

    def test_non_get_and_non_200_are_not_tagged(self, mini_client):
        # POST to a GET-only route → 405 → must pass through untouched.
        resp = mini_client.post("/v1/qa/models")

        assert resp.status_code == 405
        assert "cache-control" not in resp.headers
        assert "etag" not in resp.headers

    def test_error_responses_are_not_tagged(self):
        app = FastAPI()

        @app.get("/v1/qa/models")
        def models():
            raise HTTPException(status_code=404, detail="gone")

        app.add_middleware(ETagCacheMiddleware)
        with TestClient(app) as client:
            resp = client.get("/v1/qa/models")

        assert resp.status_code == 404
        assert "cache-control" not in resp.headers
        assert "etag" not in resp.headers


class TestRealAppIntegration:
    def test_models_endpoint_carries_cache_headers(self, client):
        resp = client.get("/v1/qa/models")

        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "public, max-age=3600, immutable"
        assert resp.headers["etag"].startswith('"')

    def test_304_round_trip_through_full_chain(self, client):
        etag = client.get("/v1/qa/models").headers["etag"]

        resp = client.get("/v1/qa/models", headers={"If-None-Match": etag})

        assert resp.status_code == 304
        assert resp.content == b""
        assert resp.headers["etag"] == etag
        assert resp.headers["cache-control"] == "public, max-age=3600, immutable"

    def test_unlisted_route_passes_through_uncached(self, client):
        # The root route is served by the full middleware chain but has no
        # caching policy — responses must arrive untouched. (/v1/health is
        # avoided: it reports 503 when no worker heartbeat exists in CI.)
        resp = client.get("/")

        assert resp.status_code == 200
        assert resp.json() == {"msg": "backend live on!"}
        assert "cache-control" not in resp.headers
        assert "etag" not in resp.headers