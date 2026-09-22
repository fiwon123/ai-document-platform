"""Tests for the document status polling endpoint."""

from uuid import UUID, uuid4

from app.models.document import DocumentDB, DocumentStatus


def _current_user_id(client, headers) -> UUID:
    me = client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    return UUID(me.json()["id"])


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

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert resp.json()["has_thumbnail"] is True

    def test_missing_document_returns_404(self, client, auth_headers, db_session):
        resp = client.get(f"/v1/documents/{uuid4()}/status", headers=auth_headers)
        assert resp.status_code == 404
        assert resp.json()["error"]["message"] == "Document not found"

    def test_other_users_document_returns_404(self, client, auth_headers, db_session):
        # A different user's document is invisible (owner scoping).
        stranger_id = uuid4()
        doc = _seed_doc(db_session, stranger_id, DocumentStatus.READY)

        resp = client.get(f"/v1/documents/{doc.id}/status", headers=auth_headers)
        assert resp.status_code == 404

    def test_requires_authentication(self, client, db_session):
        resp = client.get(f"/v1/documents/{uuid4()}/status")
        assert resp.status_code == 401