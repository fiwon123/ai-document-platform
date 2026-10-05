"""Tests for user management endpoints (/v1/users/...)."""

import uuid
from datetime import UTC, datetime, timedelta

from jose import jwt as _jwt

from app.models.refresh_session import RefreshSessionDB
from app.models.user import Role, UserDB
from app.repositories.refresh_session import RefreshSessionRepository
from app.repositories.user import UserRepository
from app.routes.auth import (
    ALGORITHM,
    REFRESH_COOKIE_NAME,
    REFRESH_COOKIE_PATH,
    SECRET_KEY,
    create_refresh_token,
)
from app.services.auth import RefreshSessionService


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


def _post_with_refresh(client, url: str, token: str | None = None):
    """Send one request carrying exactly the refresh token given (or none).

    The jar is emptied first, so the request cannot also carry whatever the
    client happens to be holding — otherwise "re-present this token" can quietly
    become "present this token and another one", and the assertion then proves
    nothing about the token named.

    The cookie is set at the server's own path so it is sent to the endpoint being
    called, which is what makes the scope assertions meaningful: a cookie set at
    httpx's default path of "/" would be delivered to `/v1/auth/logout` even if the
    server had scoped it more narrowly, hiding exactly the bug this guards.
    """
    client.cookies.clear()
    if token is not None:
        client.cookies.set(REFRESH_COOKIE_NAME, token, path=REFRESH_COOKIE_PATH)
    return client.post(url)


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
        assert resp.json()["error"]["message"] == "Passwords do not match"

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
        assert resp.json()["error"]["message"] == "Username already registered"

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
        assert resp.json()["error"]["message"] == "Nothing to update"

    def test_update_requires_auth(self, client):
        resp = client.put("/v1/users/me", json={"username": "x_x_x"})
        assert resp.status_code == 401

    def test_short_password_rejected_on_register(self, client):
        """The 8-character minimum is enforced server-side, not just in the UI."""
        resp = client.post(
            "/v1/auth/register",
            json={"username": "shorty", "password": "abc1234", "confirm_password": "abc1234"},
        )
        assert resp.status_code == 422

    def test_common_password_rejected_on_register(self, client):
        """Known-compromised passwords are refused even when long enough."""
        resp = client.post(
            "/v1/auth/register",
            json={
                "username": "weakling",
                "password": "password123",
                "confirm_password": "password123",
            },
        )
        assert resp.status_code == 422
        assert "too common" in resp.text

    def test_common_password_match_is_case_insensitive(self, client):
        resp = client.post(
            "/v1/auth/register",
            json={
                "username": "shouty",
                "password": "PassWord123",
                "confirm_password": "PassWord123",
            },
        )
        assert resp.status_code == 422
        assert "too common" in resp.text

    def test_password_over_bcrypt_limit_rejected_on_register(self, client):
        """bcrypt truncates past 72 bytes, so longer inputs are refused.

        Without this, two passwords sharing a 72-byte prefix would hash
        identically and authenticate each other.
        """
        long_password = "a1b2c3d4e5" * 8  # 80 chars, comfortably over the limit
        assert len(long_password) > 72
        resp = client.post(
            "/v1/auth/register",
            json={
                "username": "toolong",
                "password": long_password,
                "confirm_password": long_password,
            },
        )
        assert resp.status_code == 422
        assert "truncated" in resp.text

    def test_multibyte_password_over_byte_limit_rejected(self, client):
        """The limit is measured in UTF-8 bytes, not characters.

        30 four-byte characters is 120 bytes but only 30 chars — well under a
        character cap while still over the bcrypt boundary.
        """
        multibyte = "\U0001f600" * 30
        assert len(multibyte) == 30
        assert len(multibyte.encode("utf-8")) == 120
        resp = client.post(
            "/v1/auth/register",
            json={
                "username": "emojiuser",
                "password": multibyte,
                "confirm_password": multibyte,
            },
        )
        assert resp.status_code == 422
        assert "truncated" in resp.text

    def test_password_just_under_bcrypt_limit_accepted(self, client):
        """72 bytes exactly is the boundary and must be allowed."""
        exact = "a1b2c3d4e5" * 7 + "ab"  # 72 chars
        assert len(exact) == 72
        resp = client.post(
            "/v1/auth/register",
            json={"username": "exact72", "password": exact, "confirm_password": exact},
        )
        assert resp.status_code == 201

    def test_common_password_rejected_on_password_change(self, client):
        _register(client, "changer")
        headers = _login(client, "changer")

        resp = client.put(
            "/v1/users/me",
            json={"password": "12345678", "confirm_password": "12345678"},
            headers=headers,
        )
        assert resp.status_code == 422
        assert "too common" in resp.text

    def test_overlong_password_rejected_on_password_change(self, client):
        _register(client, "changer2")
        headers = _login(client, "changer2")

        long_password = "x9y8z7w6v5" * 8
        resp = client.put(
            "/v1/users/me",
            json={"password": long_password, "confirm_password": long_password},
            headers=headers,
        )
        assert resp.status_code == 422
        assert "truncated" in resp.text


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
        assert resp.json()["error"]["message"] == "Admin privileges required"

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


class TestRefreshTokens:
    """httpOnly refresh-cookie flow: login sets it, /refresh rotates it,
    /logout clears it. Access tokens are never accepted as refresh tokens."""

    def test_login_sets_refresh_cookie(self, client):
        _register(client, "cookie_user")
        login = client.post(
            "/v1/auth/login",
            data={"username": "cookie_user", "password": "testpass123"},
        )

        assert login.status_code == 200
        assert login.cookies.get("refresh_token") is not None

    def test_refresh_returns_new_access_token_and_rotates_cookie(self, client):
        _register(client, "rotator_user")
        login = client.post(
            "/v1/auth/login",
            data={"username": "rotator_user", "password": "testpass123"},
        )
        old_refresh = login.cookies.get("refresh_token")
        assert old_refresh

        resp = client.post("/v1/auth/refresh")

        assert resp.status_code == 200
        assert resp.json()["access_token"]
        assert resp.json()["user"]["username"] == "rotator_user"
        new_refresh = resp.cookies.get("refresh_token")
        assert new_refresh is not None
        assert new_refresh != old_refresh

    def test_refresh_token_works_for_api_calls(self, client):
        _register(client, "relay_user")
        client.post(
            "/v1/auth/login",
            data={"username": "relay_user", "password": "testpass123"},
        )

        refreshed = client.post("/v1/auth/refresh")
        assert refreshed.status_code == 200
        token = refreshed.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        me = client.get("/v1/auth/me", headers=headers)
        assert me.status_code == 200
        assert me.json()["username"] == "relay_user"

    def test_refresh_without_cookie_returns_401(self, client):
        resp = client.post("/v1/auth/refresh")

        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "unauthorized"

    def test_access_token_rejected_as_refresh_token(self, client):
        _register(client, "shape_user")
        login = client.post(
            "/v1/auth/login",
            data={"username": "shape_user", "password": "testpass123"},
        )
        access_token = login.json()["access_token"]
        client.cookies.set("refresh_token", access_token)

        resp = client.post("/v1/auth/refresh")

        assert resp.status_code == 401

    def test_logout_clears_the_refresh_cookie(self, client):
        """The cookie half of logout, checked on a cookie the server really set."""
        _register(client, "jar_user")
        client.post(
            "/v1/auth/login",
            data={"username": "jar_user", "password": "testpass123"},
        )
        assert client.cookies.get(REFRESH_COOKIE_NAME) is not None

        assert client.post("/v1/auth/logout").status_code == 200

        assert client.cookies.get(REFRESH_COOKIE_NAME) is None

    def test_logout_revokes_the_presented_token(self, client):
        """Logout must revoke the token, not merely delete the cookie.

        This used to be one test that asserted the cookie was gone and the next
        refresh 401'd — which the client did because it had *no cookie to send*.
        It passed against an endpoint that revoked nothing, and it also passed
        against one that revoked only the rotated token, because the single
        refresh before the logout had already retired it. So it is now split: the
        cookie check stays above, and the revocation check uses a token that was
        never exchanged, leaving the logout as the only thing that could have
        invalidated it.
        """
        _register(client, "bye_user")

        def login_token() -> str:
            resp = client.post(
                "/v1/auth/login",
                data={"username": "bye_user", "password": "testpass123"},
            )
            assert resp.status_code == 200, resp.text
            return resp.cookies.get(REFRESH_COOKIE_NAME)

        # Two independent sessions, so one can be spent refreshing while the
        # other is still live when it is logged out.
        revoked = login_token()
        spent = login_token()
        assert revoked and spent and revoked != spent

        # Sanity on the positive path: a live token really does refresh. Without
        # this, a 401 below would be indistinguishable from an endpoint that
        # refuses everything.
        assert _post_with_refresh(client, "/v1/auth/refresh", spent).status_code == 200

        assert _post_with_refresh(client, "/v1/auth/logout", revoked).status_code == 200

        # The revoked token, re-presented by something that kept a copy.
        replay = _post_with_refresh(client, "/v1/auth/refresh", revoked)
        assert replay.status_code == 401
        assert replay.json()["error"]["code"] == "unauthorized"

    def test_logout_without_a_token_still_succeeds(self, client):
        """Logging out twice, or with no cookie, is not an error."""
        _register(client, "repeat_user")
        client.post(
            "/v1/auth/login",
            data={"username": "repeat_user", "password": "testpass123"},
        )

        assert client.post("/v1/auth/logout").status_code == 200
        second = _post_with_refresh(client, "/v1/auth/logout")
        assert second.status_code == 200
        assert second.json()["message"] == "Logged out successfully"

    def test_logout_with_an_unreadable_token_still_succeeds(self, client):
        """A token that cannot be read leaves nothing to revoke, and no error."""
        _register(client, "junk_user")
        client.post(
            "/v1/auth/login",
            data={"username": "junk_user", "password": "testpass123"},
        )

        resp = _post_with_refresh(client, "/v1/auth/logout", "not-a-jwt")

        assert resp.status_code == 200
        assert resp.json()["message"] == "Logged out successfully"

    def test_logout_does_not_revoke_other_sessions(self, client):
        """Logging out of one browser must not sign the user out of another.

        Logout revokes the presented session only; revoking every session is a
        separate, explicitly-named operation, and silently doing it here would
        surprise anyone signed in on a second device.
        """
        _register(client, "twoscreen_user")

        def login_token() -> str:
            resp = client.post(
                "/v1/auth/login",
                data={"username": "twoscreen_user", "password": "testpass123"},
            )
            assert resp.status_code == 200, resp.text
            return resp.cookies.get(REFRESH_COOKIE_NAME)

        this_device = login_token()
        other_device = login_token()

        assert _post_with_refresh(client, "/v1/auth/logout", this_device).status_code == 200
        assert _post_with_refresh(client, "/v1/auth/refresh", this_device).status_code == 401
        assert _post_with_refresh(client, "/v1/auth/refresh", other_device).status_code == 200

    def test_refresh_cookie_is_reachable_by_logout(self, client):
        """Logout has to be able to read the cookie, or it can revoke nothing.

        A browser sends a cookie only to paths at or below the cookie's own path.
        The refresh cookie was scoped to `/v1/auth/refresh`, which meant the
        browser never sent it to `/v1/auth/logout` and the revocation could never
        fire in a real client while every test using the jar passed. This asserts
        the scope the server actually sets.
        """
        _register(client, "scope_user")
        resp = client.post(
            "/v1/auth/login",
            data={"username": "scope_user", "password": "testpass123"},
        )
        assert resp.status_code == 200, resp.text

        set_cookie = resp.headers.get("set-cookie", "")
        assert f"Path={REFRESH_COOKIE_PATH}" in set_cookie
        assert "/v1/auth/logout".startswith(REFRESH_COOKIE_PATH)

    def test_replayed_refresh_token_is_rejected(self, client):
        """The rotation bug: a spent token used to mint another token.

        Rotation is only meaningful if the old token stops working, so the second
        presentation of the same token must be refused.
        """
        _register(client, "replay_user")
        first = client.post(
            "/v1/auth/login",
            data={"username": "replay_user", "password": "testpass123"},
        ).cookies.get(REFRESH_COOKIE_NAME)
        assert first

        rotated = _post_with_refresh(client, "/v1/auth/refresh", first)
        assert rotated.status_code == 200, rotated.text

        replay = _post_with_refresh(client, "/v1/auth/refresh", first)
        assert replay.status_code == 401
        assert replay.json()["error"]["code"] == "unauthorized"

    def test_replay_is_reported_even_when_rotation_happened_twice(self, client):
        """Presenting an old token after several rotations is still a replay."""
        _register(client, "chain_user")
        token = client.post(
            "/v1/auth/login",
            data={"username": "chain_user", "password": "testpass123"},
        ).cookies.get(REFRESH_COOKIE_NAME)

        newest = token
        for _ in range(3):
            resp = _post_with_refresh(client, "/v1/auth/refresh", newest)
            assert resp.status_code == 200, resp.text
            newest = resp.cookies.get(REFRESH_COOKIE_NAME)

        stale = _post_with_refresh(client, "/v1/auth/refresh", token)
        assert stale.status_code == 401

    def test_refresh_token_issued_before_the_session_table_is_adopted(self, client, db_session):
        """A valid token with no stored session must still work after deploying.

        Every user holding an unexpired refresh token when this shipped has no
        row, because rows only start being written now. Refusing those tokens
        would sign out every current user on deploy, so they are adopted instead —
        but only after the signature and expiry have been verified.
        """
        _register(client, "legacy_user")
        user = db_session.query(UserDB).filter(UserDB.username == "legacy_user").one()
        issued = create_refresh_token(
            user_id=str(user.id), username=user.username, role="customer"
        )
        # No record_issue: this is exactly the pre-migration state.

        assert db_session.query(RefreshSessionDB).count() == 0

        resp = _post_with_refresh(client, "/v1/auth/refresh", issued.token)

        assert resp.status_code == 200, resp.text
        # Adopted, so the session is now tracked and a replay is caught.
        stored = db_session.query(RefreshSessionDB).filter(
            RefreshSessionDB.jti == issued.jti
        ).one()
        assert stored.rotated_at is not None
        assert _post_with_refresh(client, "/v1/auth/refresh", issued.token).status_code == 401

    def test_refresh_token_without_a_jti_is_refused(self, client, db_session):
        """A token with no jti did not come from this service, so it is not adopted."""
        _register(client, "nojti_user")
        user = db_session.query(UserDB).filter(UserDB.username == "nojti_user").one()
        role = user.role.value if user.role else "customer"
        token = _jwt.encode(
            {
                "sub": user.username,
                "id": str(user.id),
                "role": role,
                "type": "refresh",
                "exp": datetime.now(UTC) + timedelta(days=1),
            },
            SECRET_KEY,
            algorithm=ALGORITHM,
        )

        assert _post_with_refresh(client, "/v1/auth/refresh", token).status_code == 401
        assert db_session.query(RefreshSessionDB).count() == 0

    def _session_row(self, db_session, jti: str) -> RefreshSessionDB:
        user = UserDB(
            username=f"owner_{jti}", hashed_password="x", role=Role.customer  # noqa: S106
        )
        db_session.add(user)
        db_session.commit()
        row = RefreshSessionDB(
            jti=jti,
            user_id=user.id,
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
        db_session.add(row)
        db_session.commit()
        return row

    def test_a_live_token_can_only_be_retired_once(self, db_session):
        """Retirement is one-way, even when two refreshes are in flight at once.

        Two requests carrying the same token can be in the same server
        concurrently, and if both were able to retire it, both would mint a
        successor. That is the cheapest way to defeat a reuse check — the
        attacker only has to send the requests together — so the decision belongs
        to one conditional statement the database serialises, not to a read
        followed by a write.
        """
        self._session_row(db_session, "race1")
        repo = RefreshSessionRepository(db_session)
        now = datetime.now(UTC)

        assert repo.try_retire("race1", now) is True
        assert repo.try_retire("race1", now) is False

    def test_a_revoked_token_cannot_be_retired_afterwards(self, db_session):
        """Logout wins: a revoked token must stay revoked even if it is replayed."""
        self._session_row(db_session, "revoked1")
        repo = RefreshSessionRepository(db_session)
        now = datetime.now(UTC)

        assert RefreshSessionService.from_session(db_session).revoke("revoked1") is True
        assert repo.try_retire("revoked1", now) is False

    def test_revoke_is_idempotent(self, db_session):
        """Revoking twice, or a token that was never issued, is not an error."""
        self._session_row(db_session, "revoke2")
        sessions = RefreshSessionService.from_session(db_session)

        assert sessions.revoke("revoke2") is True
        assert sessions.revoke("revoke2") is True
        assert sessions.revoke("never-issued") is False

    def test_sweep_removes_expired_sessions_and_keeps_live_ones(self, db_session):
        """The session table only ever grows, so expiry has to reclaim it.

        An expired token is already refused by its own `exp`, so its row is pure
        accumulation: a user who logs in daily adds rows forever otherwise.
        """
        user = UserDB(
            username="sweeper", hashed_password="x", role=Role.customer  # noqa: S106
        )
        db_session.add(user)
        db_session.commit()

        now = datetime.now(UTC)
        db_session.add_all(
            [
                RefreshSessionDB(
                    jti="expired1", user_id=user.id, expires_at=now - timedelta(days=1)
                ),
                RefreshSessionDB(
                    jti="expired2",
                    user_id=user.id,
                    expires_at=now - timedelta(minutes=1),
                ),
                RefreshSessionDB(
                    jti="live1", user_id=user.id, expires_at=now + timedelta(days=7)
                ),
            ]
        )
        db_session.commit()

        removed = RefreshSessionService.from_session(db_session).sweep_expired()

        assert removed == 2
        remaining = db_session.query(RefreshSessionDB).all()
        assert [row.jti for row in remaining] == ["live1"]

    def test_sweep_is_a_no_op_when_nothing_has_expired(self, db_session):
        """A sweep that deletes nothing must still report nothing removed."""
        user = UserDB(
            username="sweeper2", hashed_password="x", role=Role.customer  # noqa: S106
        )
        db_session.add(user)
        db_session.commit()
        db_session.add(
            RefreshSessionDB(
                jti="live2",
                user_id=user.id,
                expires_at=datetime.now(UTC) + timedelta(days=7),
            )
        )
        db_session.commit()

        assert RefreshSessionService.from_session(db_session).sweep_expired() == 0
        assert db_session.query(RefreshSessionDB).count() == 1

    def test_refresh_session_rows_are_created_and_cascade_on_deletion(self, client, db_session):
        """Sessions belong to the account and must not outlive it."""
        _register(client, "cascadeder_user")
        user_id = client.post(
            "/v1/auth/login",
            data={"username": "cascadeder_user", "password": "testpass123"},
        ).json()["user"]["id"]

        assert db_session.query(RefreshSessionDB).count() == 1
        stored = db_session.query(RefreshSessionDB).one()
        assert str(stored.user_id) == user_id

        deleted = client.request(
            "DELETE", f"/v1/users/{user_id}", headers={"Authorization": "Bearer x"}
        )
        assert deleted.status_code in (401, 403)

        admin = _seed_admin(client, db_session)
        removed = client.delete(f"/v1/users/{user_id}", headers=admin[1])
        assert removed.status_code in (200, 204), removed.text

        assert db_session.query(RefreshSessionDB).count() == 0


class TestPasswordChangeRevokesSessions:
    """Changing a password must end the sessions it was meant to end.

    Before #518, `PUT /v1/users/me` changed the hash and nothing else, so a
    refresh cookie taken during a compromise kept working for the rest of its
    7-day life. Every test here keeps one session *untouched* — a session that is
    first exchanged would already be retired by rotation, and the 401 would be
    reported as a revocation that never happened.
    """

    def _two_sessions(self, client, username: str) -> tuple[str, str, str]:
        """Register, then log in twice. Returns (held, spare, access_token)."""
        _register(client, username)

        def login() -> tuple[str, str]:
            resp = client.post(
                "/v1/auth/login",
                data={"username": username, "password": "testpass123"},
            )
            assert resp.status_code == 200, resp.text
            return resp.cookies.get(REFRESH_COOKIE_NAME), resp.json()["access_token"]

        held, _ = login()
        spare, access = login()
        assert held and spare and held != spare
        # The positive path, proved before anything is revoked: a live session
        # really does refresh. Without this a 401 below proves nothing.
        assert _post_with_refresh(client, "/v1/auth/refresh", spare).status_code == 200
        return held, spare, access

    def test_a_password_change_revokes_an_untouched_session(self, client):
        held, _, access = self._two_sessions(client, "pwrevoked")

        changed = client.put(
            "/v1/users/me",
            json={"password": "newpass456", "confirm_password": "newpass456"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert changed.status_code == 200, changed.text

        replay = _post_with_refresh(client, "/v1/auth/refresh", held)
        assert replay.status_code == 401
        assert replay.json()["error"]["code"] == "unauthorized"

    def test_a_password_change_ends_the_callers_own_session(self, client):
        """The session that changed the password is revoked too.

        The refresh cookie is scoped to `/v1/auth`, so it is not sent to
        `/v1/users/me` and the server cannot tell which session is asking. Ending
        the caller's session as well is the consequence of not being able to, and
        the user logs back in with the new password.
        """
        _, _, access = self._two_sessions(client, "pwself")
        callers_cookie = _post_with_refresh(
            client, "/v1/auth/refresh", None
        )  # clears the jar, no cookie sent

        assert callers_cookie.status_code == 401  # sanity: no cookie -> 401

        # Log in again so the jar holds a cookie belonging to the caller, and use
        # the access token from that same login for the change.
        login = client.post(
            "/v1/auth/login",
            data={"username": "pwself", "password": "testpass123"},
        )
        own_cookie = login.cookies.get(REFRESH_COOKIE_NAME)
        own_access = login.json()["access_token"]

        changed = client.put(
            "/v1/users/me",
            json={"password": "newpass456", "confirm_password": "newpass456"},
            headers={"Authorization": f"Bearer {own_access}"},
        )
        assert changed.status_code == 200, changed.text

        assert _post_with_refresh(client, "/v1/auth/refresh", own_cookie).status_code == 401

    def test_a_username_change_revokes_nothing(self, client):
        """The control: a username is not a credential, so sessions survive it."""
        held, _, access = self._two_sessions(client, "rename_me")

        changed = client.put(
            "/v1/users/me",
            json={"username": "renamed_user"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert changed.status_code == 200, changed.text

        assert _post_with_refresh(client, "/v1/auth/refresh", held).status_code == 200

    def test_rejecting_the_change_leaves_sessions_alone(self, client):
        """Validation runs first, so a rejected change must not log anyone out.

        Otherwise a typo in the confirmation field would silently end every
        session — the user would be bounced out for a request that never applied.
        """
        held, _, access = self._two_sessions(client, "mismatch_user")

        bad = client.put(
            "/v1/users/me",
            json={"password": "newpass456", "confirm_password": "different456"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert bad.status_code == 400, bad.text

        assert _post_with_refresh(client, "/v1/auth/refresh", held).status_code == 200

    def test_other_users_sessions_are_untouched(self, client, db_session):
        """Only the account being changed is affected."""
        other = UserDB(
            username="bystander", hashed_password="x", role=Role.customer  # noqa: S106
        )
        db_session.add(other)
        db_session.commit()
        db_session.add(
            RefreshSessionDB(
                jti="bystander-session",
                user_id=other.id,
                expires_at=datetime.now(UTC) + timedelta(days=7),
            )
        )
        db_session.commit()

        _, _, access = self._two_sessions(client, "target_user")
        changed = client.put(
            "/v1/users/me",
            json={"password": "newpass456", "confirm_password": "newpass456"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert changed.status_code == 200, changed.text

        db_session.expire_all()
        bystander = (
            db_session.query(RefreshSessionDB)
            .filter(RefreshSessionDB.jti == "bystander-session")
            .one()
        )
        assert bystander.revoked_at is None

    def test_repeated_password_changes_stay_revoked(self, client, db_session):
        """Logging in again after a change creates a session that works."""
        _, _, access = self._two_sessions(client, "rotate_pw")

        first = client.put(
            "/v1/users/me",
            json={"password": "newpass456", "confirm_password": "newpass456"},
            headers={"Authorization": f"Bearer {access}"},
        )
        assert first.status_code == 200, first.text

        # The new password works, and the session it produces is live.
        again = client.post(
            "/v1/auth/login",
            data={"username": "rotate_pw", "password": "newpass456"},
        )
        assert again.status_code == 200, again.text
        fresh = again.cookies.get(REFRESH_COOKIE_NAME)
        assert _post_with_refresh(client, "/v1/auth/refresh", fresh).status_code == 200


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
        assert resp.json()["error"]["message"] == "Account is disabled"

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
        assert resp.json()["error"]["message"] == "Cannot deactivate your own account"

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