"""Smoke tests verifying the test infrastructure itself."""


def test_conftest_client_serves_app(client):
    """TestClient boots the FastAPI app and serves the root endpoint."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.json() == {"msg": "backend live on!"}


def test_auth_register_and_login(auth_headers):
    """Auth fixture registers a user and produces a Bearer token."""
    assert auth_headers["Authorization"].startswith("Bearer ")


def test_imports_app_modules():
    """Core app modules import cleanly."""
    from app.main import app
    from app.routes import auth, document, health, qa, search

    assert app.title == "AI Document Intelligence Platform"
    assert all(hasattr(module, "router") for module in (auth, document, health, qa, search))


class TestCORS:
    """CORS must allow every origin the frontend can be served from."""

    def _preflight(self, client, origin: str):
        return client.options(
            "/v1/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )

    def test_allows_dev_server_ports(self, client):
        for origin in (
            "http://localhost:5173",
            "http://localhost:5175",
            "http://localhost:3000",
        ):
            resp = self._preflight(client, origin)
            assert resp.status_code == 200, origin
            assert resp.headers.get("access-control-allow-origin") == origin

    def test_rejects_unknown_origin(self, client):
        resp = self._preflight(client, "http://evil.example.com")
        assert resp.headers.get("access-control-allow-origin") is None