"""Tests for the dashboard statistics endpoint (GET /v1/statistics/me)."""

import uuid
from uuid import UUID, uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.search import SearchHistory
from app.models.user import Role, UserDB


def _seed_doc(db_session, owner_id, status: DocumentStatus, days_ago=0):
    doc = DocumentDB(
        owner_id=owner_id,
        filename=f"{status.value}-{uuid4().hex[:6]}.txt",
        object_key=f"users/{owner_id}/documents/{uuid4()}/file.txt",
        mime_type="text/plain",
        status=status,
        error_message="boom" if status == DocumentStatus.FAILED else None,
    )
    db_session.add(doc)
    db_session.commit()
    db_session.refresh(doc)
    return doc


def _current_user_id(client, headers) -> UUID:
    me = client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    return UUID(me.json()["id"])


class TestStatisticsEndpoint:
    def test_empty_workspace_returns_zeros(self, client, auth_headers, db_session):
        resp = client.get("/v1/statistics/me", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_documents"] == 0
        assert body["total_chunks"] == 0
        assert body["recent_documents"] == []

    def test_counts_documents_and_chunks_per_status(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        ready = _seed_doc(db_session, owner_id, DocumentStatus.READY)
        _seed_doc(db_session, owner_id, DocumentStatus.PENDING)
        failed = _seed_doc(db_session, owner_id, DocumentStatus.FAILED)

        for doc, n_chunks in [(ready, 3), (failed, 1)]:
            for index in range(n_chunks):
                db_session.add(
                    DocumentChunk(
                        document_id=doc.id,
                        content=f"chunk {index}",
                        chunk_index=index,
                        embedding=None,
                    )
                )
        db_session.commit()

        resp = client.get("/v1/statistics/me", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_documents"] == 3
        assert body["ready_documents"] == 1
        assert body["pending_documents"] == 1
        assert body["processing_documents"] == 0
        assert body["failed_documents"] == 1
        assert body["total_chunks"] == 4

    def test_recent_documents_ordered_by_creation(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        older = _seed_doc(db_session, owner_id, DocumentStatus.READY)
        newer = _seed_doc(db_session, owner_id, DocumentStatus.PENDING)

        resp = client.get("/v1/statistics/me", headers=auth_headers)

        filenames = [d["filename"] for d in resp.json()["recent_documents"]]
        assert filenames == [newer.filename, older.filename]

    def test_only_counts_own_documents(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        _seed_doc(db_session, owner_id, DocumentStatus.READY)
        # A real second account, not just a random UUID: since migration 009 a
        # document must belong to an existing user, so a document "owned by
        # nobody" is no longer constructible. Seeding one would have tested
        # owner scoping against a row no owner scoping could match, which is a
        # weaker claim than the one this test is named for.
        stranger = _seed_other_user(db_session)
        _seed_doc(db_session, stranger.id, DocumentStatus.READY)

        body = client.get("/v1/statistics/me", headers=auth_headers).json()

        assert body["total_documents"] == 1

    def test_requires_authentication(self, client):
        resp = client.get("/v1/statistics/me")
        assert resp.status_code == 401


def _seed_other_user(db_session) -> UserDB:
    """Create a second, unrelated account to own rows in isolation tests."""
    other = UserDB(
        username=f"stranger_{uuid.uuid4().hex[:8]}",
        hashed_password="x",  # noqa: S106
        role=Role.customer,
    )
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)
    return other


def _seed_admin(db_session) -> UserDB:
    """Create an admin user directly in the DB (no admin reg endpoint)."""
    admin = UserDB(
        username=f"admin_{uuid.uuid4().hex[:8]}",
        hashed_password="x",  # noqa: S106
        role=Role.admin,
    )
    db_session.add(admin)
    db_session.commit()
    db_session.refresh(admin)
    return admin


def _make_token(user: UserDB) -> str:
    """Issue a signed JWT claiming the given user is an admin.

    The JWT role claim is ignored by the API (the role is read from the
    database), so this helper is also used to prove that a customer with
    a forged "admin" claim still receives 403.
    """
    from app.routes.auth import create_access_token

    return create_access_token(str(user.id), user.username, "admin")


class TestAdminStatisticsEndpoint:
    def test_empty_system_returns_zeros(self, client, db_session):
        admin = _seed_admin(db_session)
        headers = {"Authorization": f"Bearer {_make_token(admin)}"}

        resp = client.get("/v1/statistics/admin", headers=headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_users"] == 1
        assert body["active_users"] == 1
        assert body["disabled_users"] == 0
        assert body["total_documents"] == 0
        assert body["total_chunks"] == 0
        assert body["total_searches"] == 0

    def test_aggregates_across_all_users(self, client, db_session):
        admin = _seed_admin(db_session)
        headers = {"Authorization": f"Bearer {_make_token(admin)}"}

        # A regular customer with documents and searches.
        customer = UserDB(
            username=f"cust_{uuid.uuid4().hex[:8]}",
            hashed_password="x",  # noqa: S106
            role=Role.customer,
            is_active=True,
        )
        db_session.add(customer)
        db_session.commit()
        db_session.refresh(customer)

        ready = _seed_doc(db_session, customer.id, DocumentStatus.READY)
        _seed_doc(db_session, customer.id, DocumentStatus.PENDING)
        failed = _seed_doc(db_session, customer.id, DocumentStatus.FAILED)
        for doc, n_chunks in [(ready, 3), (failed, 1)]:
            for index in range(n_chunks):
                db_session.add(
                    DocumentChunk(
                        document_id=doc.id,
                        content=f"chunk {index}",
                        chunk_index=index,
                        embedding=None,
                    )
                )
        db_session.add(
            SearchHistory(user_id=customer.id, query="q1", results_count=2)
        )
        db_session.add(
            SearchHistory(user_id=customer.id, query="q2", results_count=0)
        )

        # A disabled user with one document.
        disabled = UserDB(
            username=f"disabled_{uuid.uuid4().hex[:6]}",
            hashed_password="x",  # noqa: S106
            role=Role.customer,
            is_active=False,
        )
        db_session.add(disabled)
        db_session.commit()
        db_session.refresh(disabled)
        _seed_doc(db_session, disabled.id, DocumentStatus.READY)

        resp = client.get("/v1/statistics/admin", headers=headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["total_users"] == 3
        assert body["active_users"] == 2
        assert body["disabled_users"] == 1
        assert body["total_documents"] == 4
        assert body["ready_documents"] == 2
        assert body["pending_documents"] == 1
        assert body["processing_documents"] == 0
        assert body["failed_documents"] == 1
        assert body["total_chunks"] == 4
        assert body["total_searches"] == 2

    def test_customer_gets_forbidden(self, client, db_session):
        _seed_admin(db_session)
        customer = UserDB(
            username=f"cust_{uuid.uuid4().hex[:8]}",
            hashed_password="x",  # noqa: S106
            role=Role.customer,
        )
        db_session.add(customer)
        db_session.commit()
        db_session.refresh(customer)

        headers = {"Authorization": f"Bearer {_make_token(customer)}"}

        resp = client.get("/v1/statistics/admin", headers=headers)

        assert resp.status_code == 403
        assert resp.json()["error"]["message"] == "Admin privileges required"

    def test_requires_authentication(self, client):
        resp = client.get("/v1/statistics/admin")
        assert resp.status_code == 401