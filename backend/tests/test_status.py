"""Tests for the document status polling endpoint."""

import uuid
from uuid import UUID, uuid4

from app.models.document import DocumentDB, DocumentStatus
from app.models.user import Role, UserDB


def _current_user_id(client, headers) -> UUID:
    me = client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    return UUID(me.json()["id"])


def _seed_other_user(db_session) -> UserDB:
    """A second, unrelated account, for owner-scoping tests."""
    other = UserDB(
        username=f"stranger_{uuid.uuid4().hex[:8]}",
        hashed_password="x",  # noqa: S106
        role=Role.customer,
    )
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)
    return other


def _seed_doc(
    db_session,
    owner_id,
    status: DocumentStatus,
    error_message: str | None = None,
) -> DocumentDB:
    doc = DocumentDB(
        owner_id=owner_id,
        filename="status.txt",
        object_key=f"users/{owner_id}/documents/{uuid4()}/status.txt",
        mime_type="text/plain",
        status=status,
        error_message=error_message,
    )
    db_session.add(doc)
    db_session.commit()
    return doc


class TestDocumentStatusEndpoint:
    def test_returns_status_for_ready_document(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        doc = _seed_doc(db_session, owner_id, DocumentStatus.READY)

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == str(doc.id)
        assert body["status"] == "ready"
        assert body["error_message"] is None
        # Timestamps let clients show how long the document has been in its
        # current state (updated_at refreshes on every status transition).
        assert body["created_at"]
        assert body["updated_at"]
        # Same-timezone ISO strings sort lexicographically; updated_at is
        # always >= the insert time.
        assert body["updated_at"] >= body["created_at"]

    def test_returns_error_message_for_failed_document(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        doc = _seed_doc(
            db_session,
            owner_id,
            DocumentStatus.FAILED,
            error_message="No text content could be extracted",
        )

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["status"] == "failed"
        assert resp.json()["error_message"] == "No text content could be extracted"

    def test_returns_pending_for_uploaded_document(self, client, auth_headers, db_session):
        owner_id = _current_user_id(client, auth_headers)
        _seed_doc(db_session, owner_id, DocumentStatus.PENDING)

        # Seeded documents are owned by this user; verify all statuses map.
        doc = _seed_doc(db_session, owner_id, DocumentStatus.PENDING)
        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)

        assert resp.json()["status"] == "pending"

    def test_reports_has_thumbnail_flag(self, client, auth_headers, db_session):
        # Documents without a thumbnail report has_thumbnail=false so polling
        # clients can start fetching previews the moment one exists.
        owner_id = _current_user_id(client, auth_headers)
        doc = _seed_doc(db_session, owner_id, DocumentStatus.READY)

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["has_thumbnail"] is False

        doc.has_thumbnail = True
        db_session.commit()

        # The thumbnail flag is cached like the rest of the status payload;
        # a transition invalidates it (here simulated via the same invalidation
        # hook the worker uses on status changes).
        from app.services.document import invalidate_document_cache

        invalidate_document_cache(owner_id, doc.id)

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert resp.json()["has_thumbnail"] is True

    def test_status_is_cached_between_polls(self, client, auth_headers, db_session):
        """Polls are served from the short-TTL cache until invalidated."""
        owner_id = _current_user_id(client, auth_headers)
        doc = _seed_doc(db_session, owner_id, DocumentStatus.PROCESSING)

        first = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert first.status_code == 200
        assert first.json()["status"] == "processing"

        # Transition the row behind the cache's back: the next poll must
        # still return the cached status (short TTL), not the new row.
        doc.status = DocumentStatus.READY
        doc.error_message = None
        db_session.commit()

        second = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert second.json()["status"] == "processing"  # served from cache

        from app.services.document import invalidate_document_cache

        invalidate_document_cache(owner_id, doc.id)

        third = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert third.json()["status"] == "ready"  # fresh from the database

    def test_status_cache_tracks_transitions(self, client, auth_headers, db_session):
        """document -> failed after invalidation reflects the new status."""
        from app.services.document import invalidate_document_cache

        owner_id = _current_user_id(client, auth_headers)
        doc = _seed_doc(db_session, owner_id, DocumentStatus.PROCESSING)

        client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        invalidate_document_cache(owner_id, doc.id)

        doc.status = DocumentStatus.FAILED
        doc.error_message = "Document processing failed"
        db_session.commit()

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "failed"
        assert body["error_message"] == "Document processing failed"

    def test_missing_document_returns_404(self, client, auth_headers, db_session):
        resp = client.get(f"/v1/documents/{uuid4()}/status", headers=auth_headers)
        assert resp.status_code == 404
        assert resp.json()["error"]["message"] == "Document not found"

    def test_other_users_document_returns_404(self, client, auth_headers, db_session):
        # A different user's document is invisible (owner scoping). The stranger
        # has to be a real account: since migration 009 a document must belong to
        # an existing user, so seeding a document under a bare UUID would test
        # owner scoping against a row no scoping rule could ever match.
        stranger = _seed_other_user(db_session)
        doc = _seed_doc(db_session, stranger.id, DocumentStatus.READY)

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert resp.status_code == 404

    def test_requires_authentication(self, client, db_session):
        resp = client.get(f"/v1/documents/{uuid4()}/status")
        assert resp.status_code == 401