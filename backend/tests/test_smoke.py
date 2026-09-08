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
    from app.main import app  # noqa: F401
    from app.routes import auth, document, health, qa, search  # noqa: F401

    assert app.title == "AI Document Intelligence Platform"