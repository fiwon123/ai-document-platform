"""Tests for the dashboard statistics endpoint (GET /v1/statistics/me)."""

from uuid import UUID, uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus


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
        _seed_doc(db_session, uuid4(), DocumentStatus.READY)  # stranger's doc

        body = client.get("/v1/statistics/me", headers=auth_headers).json()

        assert body["total_documents"] == 1

    def test_requires_authentication(self, client):
        resp = client.get("/v1/statistics/me")
        assert resp.status_code == 401