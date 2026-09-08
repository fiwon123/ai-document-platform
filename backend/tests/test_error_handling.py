"""Tests for the standardized error response envelope."""

import uuid

from fastapi.testclient import TestClient

from app.database.db import get_db
from app.main import app


def _client(db_session) -> TestClient:
    from fastapi.testclient import TestClient

    def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client
    app.dependency_overrides.clear()


def _register(client, username):
    resp = client.post(
        "/v1/auth/register",
        json={
            "username": username,
            "password": "testpass123",
            "confirm_password": "testpass123",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client, username):
    resp = client.post(
        "/v1/auth/login",
        data={"username": username, "password": "testpass123"},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _assert_error_shape(body, code: str, status: int):
    """The envelope is {error: {code, message, details?}}."""
    assert "error" in body
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    if body["error"]["details"] is not None:
        assert isinstance(body["error"]["details"], dict)


class TestErrorEnvelope:
    def test_404_uses_envelope(self, db_session):
        client = next(_client(db_session))
        _register(client, "err_user")
        headers = _login(client, "err_user")

        resp = client.get(
            f"/v1/documents/{uuid.uuid4()}", headers=headers
        )

        assert resp.status_code == 404
        _assert_error_shape(resp.json(), "not_found", 404)

    def test_401_uses_envelope(self, db_session):
        client = next(_client(db_session))
        resp = client.get("/v1/auth/me")
        assert resp.status_code == 401
        _assert_error_shape(resp.json(), "unauthorized", 401)

    def test_403_uses_envelope(self, db_session):
        client = next(_client(db_session))
        _register(client, "wrong_role")
        headers = _login(client, "wrong_role")

        resp = client.get("/v1/users/", headers=headers)

        assert resp.status_code == 403
        _assert_error_shape(resp.json(), "forbidden", 403)

    def test_400_uses_envelope(self, db_session):
        client = next(_client(db_session))
        _register(client, "dup_name")

        resp = client.post(
            "/v1/auth/register",
            json={
                "username": "dup_name",
                "password": "testpass123",
                "confirm_password": "testpass123",
            },
        )

        assert resp.status_code == 409
        _assert_error_shape(resp.json(), "conflict", 409)

    def test_validation_error_has_field_details(self, db_session):
        client = next(_client(db_session))
        resp = client.post(
            "/v1/auth/register",
            json={"username": "x", "password": "short", "confirm_password": "short"},
        )

        assert resp.status_code == 422
        body = resp.json()
        _assert_error_shape(body, "validation_error", 422)
        assert body["error"]["details"] is not None

    def test_delete_uses_envelope(self, db_session):

        client = next(_client(db_session))
        _register(client, "del_user")
        headers = _login(client, "del_user")

        resp = client.delete(
            f"/v1/documents/{uuid.uuid4()}", headers=headers
        )
        assert resp.status_code == 404
        _assert_error_shape(resp.json(), "not_found", 404)

    def test_unhandled_exception_returns_generic_500(self, db_session):
        """Raw exceptions become a generic 500 without leaking internals."""
        from app.services.document import DocumentService

        client = next(_client(db_session))
        _register(client, "boom_user")
        headers = _login(client, "boom_user")

        def _boom(self, *args, **kwargs):
            raise RuntimeError("secret internal detail")

        original_get = DocumentService.get

        try:
            DocumentService.get = _boom
            resp = client.get(
                f"/v1/documents/{uuid.uuid4()}", headers=headers
            )
        finally:
            DocumentService.get = original_get

        assert resp.status_code == 500
        body = resp.json()
        _assert_error_shape(body, "internal_error", 500)
        assert "secret internal detail" not in body["error"]["message"]