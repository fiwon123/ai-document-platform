"""Tests for user management endpoints (/v1/users/...)."""

import uuid

from app.models.user import Role, UserDB
from app.repositories.user import UserRepository


def _register(client, username, password="testpass123"):  # noqa: S107
    resp = client.post(
        "/v1/auth/register",
        json={
            "username": username,
            "password": password,
            "confirm_password": password,
        },
    )
    return resp


def _login(client, username, password="testpass123"):  # noqa: S107
    resp = client.post(
        "/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _make_user(username: str = "jane", role: Role = Role.customer) -> UserDB:
    return UserDB(username=username, hashed_password="x", role=role)  # noqa: S106


class TestUpdateCurrentUser:
    def test_update_username(self, client, db_session):
        _register(client, "before_name")
        headers = _login(client, "before_name")

        resp = client.put(
            "/v1/users/me",
            json={"username": "after_name"},
            headers=headers,
        )

        assert resp.status_code == 200
        assert resp.json()["username"] == "after_name"

        # Old username no longer works, new one does.
        old_login = client.post(
            "/v1/auth/login",
            data={"username": "before_name", "password": "testpass123"},
        )
        assert old_login.status_code == 401
        new_login = client.post(
            "/v1/auth/login",
            data={"username": "after_name", "password": "testpass123"},
        )
        assert new_login.status_code == 200

    def test_update_password_then_login_with_it(self, client):
        _register(client, "pw_user", password="oldpassword123")  # noqa: S106
        headers = _login(client, "pw_user", password="oldpassword123")  # noqa: S106

        resp = client.put(
            "/v1/users/me",
            json={
                "password": "newpassword456",
                "confirm_password": "newpassword456",
            },
            headers=headers,
        )
        assert resp.status_code == 200

        # Old password rejected, new one accepted.
        old_login = client.post(
            "/v1/auth/login",
            data={"username": "pw_user", "password": "oldpassword123"},
        )
        assert old_login.status_code == 401
        new_login = client.post(
            "/v1/auth/login",
            data={"username": "pw_user", "password": "newpassword456"},
        )
        assert new_login.status_code == 200

    def test_password_mismatch_returns_400(self, client):
        _register(client, "mismatch_user")
        headers = _login(client, "mismatch_user")

        resp = client.put(
            "/v1/users/me",
            json={"password": "newpassword456", "confirm_password": "different456"},
            headers=headers,
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Passwords do not match"

    def test_username_conflict_returns_409(self, client):
        _register(client, "taken_name")
        _register(client, "claimer")
        headers = _login(client, "claimer")

        resp = client.put(
            "/v1/users/me",
            json={"username": "taken_name"},
            headers=headers,
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == "Username already registered"

    def test_own_username_is_not_a_conflict(self, client):
        _register(client, "same_user")
        headers = _login(client, "same_user")

        resp = client.put(
            "/v1/users/me",
            json={"username": "same_user"},
            headers=headers,
        )
        assert resp.status_code == 200

    def test_empty_update_returns_400(self, client):
        _register(client, "nothing_user")
        headers = _login(client, "nothing_user")

        resp = client.put("/v1/users/me", json={}, headers=headers)
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Nothing to update"

    def test_update_requires_auth(self, client):
        resp = client.put("/v1/users/me", json={"username": "x_x_x"})
        assert resp.status_code == 401


class TestDeleteCurrentUser:
    def test_delete_own_account(self, client, db_session):
        _register(client, "to_delete")
        headers = _login(client, "to_delete")

        resp = client.delete("/v1/users/me", headers=headers)
        assert resp.status_code == 204

        # No longer valid: /me fails for the deleted user.
        me = client.get("/v1/auth/me", headers=headers)
        assert me.status_code == 401

        me2 = client.get("/v1/auth/me", headers=headers)
        assert me2.status_code == 401


def _seed_admin(client, db_session):
    """Create an admin user directly in the DB (no admin reg endpoint)."""
    admin = UserDB(
        username=f"admin_{uuid.uuid4().hex[:8]}",
        hashed_password="x",  # noqa: S106
        role=Role.admin,
    )
    db_session.add(admin)
    db_session.commit()
    token = _make_admin_token(admin)
    return admin, {"Authorization": f"Bearer {token}"}


class TestAdminEndpoints:
    def test_customer_cannot_list_users(self, client, db_session):
        _register(client, "plain_user")
        headers = _login(client, "plain_user")

        resp = client.get("/v1/users/", headers=headers)
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Admin privileges required"

    def test_admin_can_list_users(self, client, db_session):
        _register(client, "visible_user")
        admin, headers = _seed_admin(client, db_session)

        resp = client.get("/v1/users/", headers=headers)

        assert resp.status_code == 200
        usernames = [u["username"] for u in resp.json()]
        assert "visible_user" in usernames

    def test_admin_can_change_role(self, client, db_session):
        target_name = f"target_{uuid.uuid4().hex[:6]}"
        _register(client, target_name)
        _, headers = _seed_admin(client, db_session)

        target = UserRepository(db_session).get_by_username(target_name)

        resp = client.patch(
            f"/v1/users/{target.id}/role",
            json={"role": "admin"},
            headers=headers,
        )

        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
        db_session.refresh(target)
        assert target.role == Role.admin

    def test_admin_can_delete_user(self, client, db_session):
        victim_name = f"victim_{uuid.uuid4().hex[:6]}"
        client.post(
            "/v1/auth/register",
            json={
                "username": victim_name,
                "password": "testpass123",
                "confirm_password": "testpass123",
            },
        )
        victim = UserRepository(db_session).get_by_username(victim_name)
        admin, headers = _seed_admin(client, db_session)

        resp = client.delete(f"/v1/users/{victim.id}", headers=headers)

        assert resp.status_code == 204
        assert UserRepository(db_session).get_by_id(victim.id) is None

    def test_admin_endpoints_require_auth(self, client, db_session):
        resp = client.get("/v1/users/")
        assert resp.status_code == 401


class TestUserDeactivation:
    """Deactivated accounts must not be able to log in or use the API."""

    def _deactivate(self, client, db_session, user_id, admin_headers):
        resp = client.patch(
            f"/v1/users/{user_id}/active",
            json={"is_active": False},
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_login_rejected_for_deactivated_user(self, client, db_session):
        _register(client, "soon_disabled")
        admin, admin_headers = _seed_admin(client, db_session)

        user = UserRepository(db_session).get_by_username("soon_disabled")
        self._deactivate(client, db_session, user.id, admin_headers)

        resp = client.post(
            "/v1/auth/login",
            data={"username": "soon_disabled", "password": "testpass123"},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Account is disabled"

    def test_valid_token_rejected_for_deactivated_user(self, client, db_session):
        """A token issued before deactivation must stop working."""
        _register(client, "token_hunter")
        headers = _login(client, "token_hunter")
        admin, admin_headers = _seed_admin(client, db_session)

        user = UserRepository(db_session).get_by_username("token_hunter")
        self._deactivate(client, db_session, user.id, admin_headers)

        # Pre-existing token no longer grants access.
        me = client.get("/v1/auth/me", headers=headers)
        assert me.status_code == 401
        docs = client.get("/v1/documents/", headers=headers)
        assert docs.status_code == 401

    def test_admin_can_reactivate_user(self, client, db_session):
        _register(client, "back_again")
        admin, admin_headers = _seed_admin(client, db_session)

        user = UserRepository(db_session).get_by_username("back_again")
        self._deactivate(client, db_session, user.id, admin_headers)

        resp = client.patch(
            f"/v1/users/{user.id}/active",
            json={"is_active": True},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        assert resp.json()["is_active"] is True

        login = client.post(
            "/v1/auth/login",
            data={"username": "back_again", "password": "testpass123"},
        )
        assert login.status_code == 200

    def test_admin_cannot_deactivate_self(self, client, db_session):
        admin, admin_headers = _seed_admin(client, db_session)

        resp = client.patch(
            f"/v1/users/{admin.id}/active",
            json={"is_active": False},
            headers=admin_headers,
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Cannot deactivate your own account"

    def test_deactivate_requires_admin(self, client, db_session):
        _register(client, "some_admin_target")
        admin, _ = _seed_admin(client, db_session)
        user = UserRepository(db_session).get_by_username("some_admin_target")

        customer_headers = _login(client, "some_admin_target")
        resp = client.patch(
            f"/v1/users/{user.id}/active",
            json={"is_active": False},
            headers=customer_headers,
        )
        assert resp.status_code == 403


def _make_admin_token(admin: UserDB) -> str:
    """Issue a signed JWT for an admin user via the app's own helper."""
    from app.routes.auth import create_access_token

    return create_access_token(str(admin.id), admin.username, "admin")