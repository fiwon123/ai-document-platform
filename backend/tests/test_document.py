"""Tests for document endpoints: upload, list, get, delete, download.

Storage (MinIO) and the worker queue are always mocked — no real
external services are contacted.
"""

import time
from unittest.mock import MagicMock
from uuid import UUID, uuid4

from app.models.document import DocumentStatus

UPLOAD_FILENAME = "notes.txt"


def _post_upload(client, headers, content=b"hello world", filename=UPLOAD_FILENAME,
                 content_type="text/plain"):
    return client.post(
        "/v1/documents/",
        files={"upload_file": (filename, content, content_type)},
        headers=headers,
    )


def _mock_upload_ok(monkeypatch):
    """Storage upload + worker enqueue succeed without external calls."""
    from app.services import document as document_module
    from app.storage.storage import storage as app_storage

    monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
    monkeypatch.setattr(document_module, "process_document_task", lambda _id: None)


def _register_second_user(client) -> dict:
    """Register + login a second unique user for isolation tests."""
    import uuid

    username = f"other_{uuid.uuid4().hex[:10]}"
    password = "testpass123"
    register = client.post(
        "/v1/auth/register",
        json={
            "username": username,
            "password": password,
            "confirm_password": password,
        },
    )
    assert register.status_code == 201, register.text
    login = client.post(
        "/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


class TestUploadValidation:
    def test_upload_success_returns_201(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)

        resp = _post_upload(client, auth_headers)

        assert resp.status_code == 201
        body = resp.json()
        assert body["status"] == "pending"
        assert body["filename"] == UPLOAD_FILENAME

    def test_rejects_unsupported_extension(self, client, auth_headers):
        resp = _post_upload(
            client,
            auth_headers,
            content=b"evil",
            filename="malware.exe",
            content_type="application/octet-stream",
        )
        assert resp.status_code == 400
        assert "Unsupported file type" in resp.json()["error"]["message"]

    def test_rejects_unsupported_content_type(self, client, auth_headers):
        resp = _post_upload(
            client, auth_headers, filename="notes.txt", content_type="application/x-msdownload"
        )
        assert resp.status_code == 400
        assert "Unsupported file type" in resp.json()["error"]["message"]

    def test_rejects_oversized_file(self, client, auth_headers):
        # 25 MB + 1 byte
        big = b"a" * (25 * 1024 * 1024 + 1)
        resp = _post_upload(client, auth_headers, content=big, filename="big.txt")
        assert resp.status_code == 413
        assert "too large" in resp.json()["error"]["message"].lower()

    def test_rejects_empty_file(self, client, auth_headers):
        resp = _post_upload(client, auth_headers, content=b"", filename="empty.txt")
        assert resp.status_code == 400
        assert "empty" in resp.json()["error"]["message"].lower()

    def test_rejects_invalid_filename(self, client, auth_headers):
        resp = _post_upload(client, auth_headers, filename="..")
        assert resp.status_code == 400
        assert resp.json()["error"]["message"] == "Invalid filename"

    def test_sanitizes_control_characters_in_filename(
        self, client, auth_headers, monkeypatch
    ):
        _mock_upload_ok(monkeypatch)

        resp = _post_upload(
            client, auth_headers, filename="bad\x00name.txt", content_type="text/plain"
        )

        assert resp.status_code == 201
        assert resp.json()["filename"] == "badname.txt"

    def test_octet_stream_accepted_when_extension_valid(
        self, client, auth_headers, monkeypatch
    ):
        _mock_upload_ok(monkeypatch)

        resp = _post_upload(
            client, auth_headers, filename="notes.txt", content_type="application/octet-stream"
        )
        assert resp.status_code == 201


class TestUploadFailures:
    def test_storage_failure_returns_503(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(
            app_storage, "upload", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("s3 down"))
        )

        resp = _post_upload(client, auth_headers)

        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "service_unavailable"

    def test_db_failure_returns_500_and_cleans_up_object(
        self, client, auth_headers, monkeypatch
    ):
        from app.repositories.document import DocumentRepository
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        monkeypatch.setattr(
            DocumentRepository,
            "create",
            lambda self, doc: (_ for _ in ()).throw(RuntimeError("db down")),
        )
        deleted = []
        monkeypatch.setattr(
            app_storage, "delete", lambda object_key: deleted.append(object_key)
        )

        resp = _post_upload(client, auth_headers)

        assert resp.status_code == 500
        assert resp.json()["error"]["code"] == "internal_error"
        # The orphaned object must have been removed from storage.
        assert len(deleted) == 1
        assert deleted[0].endswith(UPLOAD_FILENAME)

    def test_processing_failure_marks_document_failed(
        self, client, auth_headers, monkeypatch
    ):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        monkeypatch.setattr(
            document_module,
            "process_document_task",
            lambda _id: (_ for _ in ()).throw(RuntimeError("extraction boom")),
        )

        resp = _post_upload(client, auth_headers)

        assert resp.status_code == 201
        assert resp.json()["status"] == "failed"
        assert "Failed to process document" in resp.json()["error_message"]


class TestListDocuments:
    def test_requires_auth(self, client):
        resp = client.get("/v1/documents/")
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "unauthorized"

    def test_returns_only_owned_documents(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        other_headers = _register_second_user(client)

        _create_document(client, auth_headers)
        _create_document(client, other_headers)

        mine = client.get("/v1/documents/", headers=auth_headers)
        theirs = client.get("/v1/documents/", headers=other_headers)

        assert mine.status_code == 200
        assert len(mine.json()) == 1
        assert mine.json()[0]["filename"] == UPLOAD_FILENAME
        assert theirs.status_code == 200
        assert len(theirs.json()) == 1

    def test_pagination(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        for i in range(3):
            _create_document(client, auth_headers, filename=f"doc-{i}.txt")

        first = client.get("/v1/documents/?limit=2", headers=auth_headers)
        second = client.get("/v1/documents/?skip=2&limit=2", headers=auth_headers)

        assert first.status_code == 200
        assert len(first.json()) == 2
        assert second.status_code == 200
        assert len(second.json()) == 1
        names = [d["filename"] for d in first.json() + second.json()]
        # Newest first (created_at desc): doc-2, doc-1, then doc-0.
        assert names == ["doc-2.txt", "doc-1.txt", "doc-0.txt"]


class TestGetDocument:
    def test_returns_document(self, client, auth_headers, monkeypatch, db_session):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        doc_id = created["id"]

        resp = client.get(f"/v1/documents/{doc_id}", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["id"] == doc_id
        assert resp.json()["filename"] == UPLOAD_FILENAME

    def test_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.get(f"/v1/documents/{uuid4()}", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_ownership_isolation(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        other_headers = _register_second_user(client)

        resp = client.get(f"/v1/documents/{created['id']}", headers=other_headers)

        assert resp.status_code == 404


class TestDeleteDocument:
    def test_delete_success_removes_storage_and_db(
        self, client, auth_headers, monkeypatch
    ):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        doc_id = created["id"]

        deleted = []
        monkeypatch.setattr(app_storage, "delete", lambda object_key: deleted.append(object_key))

        resp = client.delete(f"/v1/documents/{doc_id}", headers=auth_headers)

        assert resp.status_code == 200
        assert resp.json()["document_id"] == doc_id
        # Original object + thumbnail object are both removed.
        assert len(deleted) == 2
        assert deleted[0].endswith(UPLOAD_FILENAME)
        assert deleted[1].endswith("thumbnail.png")
        # The row is gone from the database too.
        assert client.get(f"/v1/documents/{doc_id}", headers=auth_headers).status_code == 404

    def test_delete_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.delete(f"/v1/documents/{uuid4()}", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_delete_processed_document_removes_its_chunks(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """Deleting a document that was already processed (has chunks) must
        succeed and remove the chunks — regression for the NotNullViolation
        on document_chunks.document_id caused by the ORM nullifying the FK
        before the DB CASCADE (no passive_deletes on the relationship)."""
        from app.models.chunk import DocumentChunk
        from app.models.document import DocumentDB
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        doc_id = created["id"]

        deleted = []
        monkeypatch.setattr(app_storage, "delete", lambda object_key: deleted.append(object_key))

        # Simulate the worker having processed the document: attach chunks
        # directly, as extraction + chunking would.
        doc = db_session.query(DocumentDB).filter(DocumentDB.id == doc_id).one()
        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id,
                    content=f"chunk {i} of the processed document",
                    chunk_index=i,
                )
                for i in range(3)
            ]
        )
        db_session.commit()

        resp = client.delete(f"/v1/documents/{doc_id}", headers=auth_headers)

        assert resp.status_code == 200, resp.text
        assert resp.json()["document_id"] == doc_id
        # Both storage objects (document + thumbnail) were removed.
        assert len(deleted) == 2
        remaining = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc_id)
            .count()
        )
        assert remaining == 0

    def test_delete_ownership_isolation(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        other_headers = _register_second_user(client)

        deleted = []
        monkeypatch.setattr(app_storage, "delete", lambda object_key: deleted.append(object_key))

        resp = client.delete(f"/v1/documents/{created['id']}", headers=other_headers)

        assert resp.status_code == 404
        assert deleted == []

    def test_delete_invalidates_caches(self, client, auth_headers, monkeypatch):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        monkeypatch.setattr(app_storage, "delete", lambda object_key: None)

        invalidate_doc = MagicMock()
        invalidate_search = MagicMock()
        monkeypatch.setattr(document_module, "invalidate_document_cache", invalidate_doc)
        monkeypatch.setattr(
            "app.services.search.invalidate_user_search_cache", invalidate_search
        )
        # The service imports the function by name; patch it on the module too.
        monkeypatch.setattr(
            "app.services.document.invalidate_user_search_cache", invalidate_search
        )

        client.delete(f"/v1/documents/{created['id']}", headers=auth_headers)

        invalidate_doc.assert_called_once()
        invalidate_search.assert_called_once()


class TestReprocessDocument:
    """POST /documents/{id}/reprocess re-enqueues a terminal document."""

    def _mark_failed(self, client, auth_headers, document_id, db_session):
        from uuid import UUID

        from app.models.document import DocumentDB

        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(document_id))
            .one()
        )
        row.status = DocumentStatus.FAILED
        row.error_message = "Processing did not complete within the timeout"
        db_session.commit()
        return row

    def test_reprocess_failed_document(self, client, auth_headers, db_session, monkeypatch):
        from app.services import document as document_module

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._mark_failed(client, auth_headers, created["id"], db_session)

        enqueued = []
        monkeypatch.setattr(
            document_module,
            "process_document_task",
            lambda doc_id: enqueued.append(doc_id),
        )

        resp = client.post(
            f"/v1/documents/{created['id']}/reprocess", headers=auth_headers
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "pending"
        assert body["document_id"] == created["id"]
        assert str(enqueued[0]) == created["id"]

    def test_reprocess_ready_document_allowed(self, client, auth_headers, db_session, monkeypatch):
        from uuid import UUID

        from app.models.document import DocumentDB

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(created["id"]))
            .one()
        )
        row.status = DocumentStatus.READY
        db_session.commit()

        enqueued = []
        monkeypatch.setattr(
            "app.services.document.process_document_task",
            lambda doc_id: enqueued.append(doc_id),
        )

        resp = client.post(
            f"/v1/documents/{created['id']}/reprocess", headers=auth_headers
        )

        assert resp.status_code == 200
        assert resp.json()["status"] == "pending"
        assert len(enqueued) == 1

    def test_rejects_already_processing(self, client, auth_headers, db_session, monkeypatch):
        from uuid import UUID

        from app.models.document import DocumentDB

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(created["id"]))
            .one()
        )
        row.status = DocumentStatus.PROCESSING
        db_session.commit()

        monkeypatch.setattr(
            "app.services.document.process_document_task", lambda _id: None
        )

        resp = client.post(
            f"/v1/documents/{created['id']}/reprocess", headers=auth_headers
        )

        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "conflict"

    def test_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.post(
            f"/v1/documents/{uuid4()}/reprocess", headers=auth_headers
        )

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_ownership_isolation(self, client, auth_headers, db_session, monkeypatch):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._mark_failed(client, auth_headers, created["id"], db_session)
        other_headers = _register_second_user(client)

        monkeypatch.setattr(
            "app.services.document.process_document_task", lambda _id: None
        )

        resp = client.post(
            f"/v1/documents/{created['id']}/reprocess", headers=other_headers
        )

        assert resp.status_code == 404


class TestDownloadDocument:
    def test_returns_an_api_link_carrying_a_token(self, client, auth_headers, monkeypatch):

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)

        resp = client.get(f"/v1/documents/{created['id']}/download", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["filename"] == UPLOAD_FILENAME
        # A path on the API origin, not a storage host (#536). The browser
        # resolves `/v1` because the frontend proxies it, so nothing here has to
        # know where the object store is published.
        assert body["download_url"].startswith(f"/v1/documents/{created['id']}/content?")
        assert "kind=original" in body["download_url"]
        # And no storage host appears anywhere in it: a link that named one
        # would be a guess about the browser's network, and the guess is wrong
        # in every environment but one.
        assert "minio" not in body["download_url"]
        assert "storage.example" not in body["download_url"]

    def test_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.get(f"/v1/documents/{uuid4()}/download", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_ownership_isolation(self, client, auth_headers, monkeypatch):

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        other_headers = _register_second_user(client)

        resp = client.get(f"/v1/documents/{created['id']}/download", headers=other_headers)

        assert resp.status_code == 404


class TestDocumentThumbnail:
    """GET /documents/{id}/thumbnail serves a link to the rendered PNG.

    The link names the API and carries a token, because an ``<img src>`` cannot
    send an Authorization header and a storage URL would have to guess which
    host the browser can reach (#536).
    """

    @staticmethod
    def _mark_has_thumbnail(client, db_session, document_id):
        """Simulate the worker having generated a thumbnail for the doc."""
        from uuid import UUID

        from app.models.document import DocumentDB

        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(document_id))
            .one()
        )
        row.has_thumbnail = True
        db_session.commit()
        return row

    def test_file_response_includes_has_thumbnail(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)

        assert created["has_thumbnail"] is False

    def test_returns_404_when_no_thumbnail(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)

        resp = client.get(f"/v1/documents/{created['id']}/thumbnail", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_returns_presigned_url_when_thumbnail_exists(
        self, client, auth_headers, db_session, monkeypatch
    ):

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._mark_has_thumbnail(client, db_session, created["id"])

        resp = client.get(f"/v1/documents/{created['id']}/thumbnail", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == created["id"]
        # The link names the API, the asset kind, and a token — never a storage
        # host (#536). `doc` is still asserted on below for the content test.
        assert body["thumbnail_url"].startswith(f"/v1/documents/{created['id']}/content?")
        assert "kind=thumbnail" in body["thumbnail_url"]
        assert "minio" not in body["thumbnail_url"]

    def test_ownership_isolation(self, client, auth_headers, db_session, monkeypatch):

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._mark_has_thumbnail(client, db_session, created["id"])
        other_headers = _register_second_user(client)

        resp = client.get(f"/v1/documents/{created['id']}/thumbnail", headers=other_headers)

        assert resp.status_code == 404


class TestDocumentContent:
    """GET /documents/{id}/content serves the bytes a token points at (#536).

    This is the endpoint the presigned storage URL used to point *at*. The
    browser can always reach it, because it is on the API origin it already
    talks to, and the token in the query string carries the authority — the only
    place an ``<img src>`` can put one.
    """

    THUMBNAIL_PNG = b"\x89PNG\r\n\x1a\nthumbnail-bytes"

    @staticmethod
    def _fake_storage(monkeypatch, payload: bytes):
        """Point `open_object` at bytes instead of a bucket."""
        from app.storage.storage import storage as app_storage

        opened = []

        class _Body:
            def __init__(self, data):
                self._data = data

            def __iter__(self):
                return iter([self._data])

            def close(self):
                pass

        def open_object(object_key):
            opened.append(object_key)
            return _Body(payload), len(payload)

        monkeypatch.setattr(app_storage, "open_object", open_object)
        return opened

    def _create_with_thumbnail(self, client, auth_headers, db_session):
        from app.models.document import DocumentDB

        created = _create_document(client, auth_headers)
        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(created["id"]))
            .one()
        )
        row.has_thumbnail = True
        db_session.commit()
        return created

    def test_thumbnail_is_served_as_png_bytes(
        self, client, auth_headers, db_session, monkeypatch
    ):
        from app.services.media_tokens import issue_token

        created = self._create_with_thumbnail(client, auth_headers, db_session)
        self._fake_storage(monkeypatch, self.THUMBNAIL_PNG)
        token = issue_token(UUID(created["id"]), "thumbnail")

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={"kind": "thumbnail", "token": token},
        )

        assert resp.status_code == 200
        assert resp.content == self.THUMBNAIL_PNG
        # A thumbnail is displayed, not downloaded, and it is per-user.
        assert resp.headers["content-type"] == "image/png"
        assert resp.headers["content-disposition"].startswith("inline")
        assert resp.headers["cache-control"].startswith("private")
        assert int(resp.headers["content-length"]) == len(self.THUMBNAIL_PNG)

    def test_original_is_an_attachment_named_after_the_file(
        self, client, auth_headers, monkeypatch
    ):
        from app.services.media_tokens import issue_token

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._fake_storage(monkeypatch, b"hello world")
        token = issue_token(UUID(created["id"]), "original")

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={"kind": "original", "token": token},
        )

        assert resp.status_code == 200
        assert resp.content == b"hello world"
        disposition = resp.headers["content-disposition"]
        assert disposition.startswith("attachment")
        assert UPLOAD_FILENAME in disposition

    def test_thumbnail_and_original_are_different_objects(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """The point of `kind` being inside the signed message.

        Without it, a token obtained by any user for a preview would fetch the
        original file — which for a user with read access is harmless and for
        anyone who can read a link is not.
        """
        from app.services.media_tokens import issue_token

        created = self._create_with_thumbnail(client, auth_headers, db_session)
        opened = self._fake_storage(monkeypatch, b"x")

        client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "thumbnail",
                "token": issue_token(UUID(created["id"]), "thumbnail"),
            },
        )
        client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "original",
                "token": issue_token(UUID(created["id"]), "original"),
            },
        )

        assert len(opened) == 2
        assert opened[0].endswith("/thumbnail.png")
        assert not opened[1].endswith("thumbnail.png")

    def test_a_token_for_another_document_is_refused(
        self, client, auth_headers, db_session, monkeypatch
    ):
        from app.services.media_tokens import issue_token

        created = self._create_with_thumbnail(client, auth_headers, db_session)
        opened = self._fake_storage(monkeypatch, b"x")
        other = uuid4()

        resp = client.get(
            f"/v1/documents/{other}/content",
            params={
                "kind": "thumbnail",
                "token": issue_token(UUID(created["id"]), "thumbnail"),
            },
        )

        # 403, not 404: the link is not valid *for this path*. And the database
        # is never consulted, so a forged link cannot probe for existence.
        assert resp.status_code == 403
        assert opened == []

    def test_a_token_cannot_be_edited_into_another(
        self, client, auth_headers, db_session, monkeypatch
    ):
        from app.services.media_tokens import issue_token

        created = self._create_with_thumbnail(client, auth_headers, db_session)
        opened = self._fake_storage(monkeypatch, b"x")
        token = issue_token(UUID(created["id"]), "thumbnail")

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "thumbnail",
                "token": token[:-1] + ("0" if token[-1] != "0" else "1"),
            },
        )

        assert resp.status_code == 403
        assert opened == []

    def test_an_expired_token_is_refused(
        self, client, auth_headers, db_session, monkeypatch
    ):
        from app.services.media_tokens import issue_token

        created = self._create_with_thumbnail(client, auth_headers, db_session)
        opened = self._fake_storage(monkeypatch, b"x")
        # Issued an hour ago with a one-minute life: expired without sleeping.
        stale = issue_token(
            UUID(created["id"]),
            "thumbnail",
            ttl_seconds=60,
            now=time.time() - 3600,
        )

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={"kind": "thumbnail", "token": stale},
        )

        assert resp.status_code == 403
        assert opened == []

    def test_missing_or_malformed_token_is_refused(self, client, auth_headers, db_session):
        created = self._create_with_thumbnail(client, auth_headers, db_session)

        for token in ("", "garbage", "123", "123.abc", "."):
            resp = client.get(
                f"/v1/documents/{created['id']}/content",
                params={"kind": "thumbnail", "token": token},
            )
            assert resp.status_code == 403, token

        # Absent entirely: FastAPI's own validation, 422 rather than 403.
        resp = client.get(f"/v1/documents/{created['id']}/content", params={"kind": "thumbnail"})
        assert resp.status_code == 422

    def test_a_thumbnail_that_does_not_exist_is_404_not_403(
        self, client, auth_headers, monkeypatch
    ):
        """The distinction a browser acts on.

        A valid link to a document with no preview must let the card fall back
        to its type chip, which is what 404 achieves. 403 would look like a
        broken page instead, and would also be a lie: the link is fine.
        """
        from app.services.media_tokens import issue_token

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)  # has_thumbnail is False
        self._fake_storage(monkeypatch, b"x")

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "thumbnail",
                "token": issue_token(UUID(created["id"]), "thumbnail"),
            },
        )

        assert resp.status_code == 404

    def test_a_storage_failure_is_404_and_never_a_500(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """A missing object in the bucket is a missing asset, not a server error.

        This is the shape of the bug that started all of it: the card must show
        its chip, and the audit must see a 404 it can attribute to storage
        rather than a 500 it has to investigate.
        """
        from app.services.media_tokens import issue_token
        from app.storage.storage import storage as app_storage

        created = self._create_with_thumbnail(client, auth_headers, db_session)

        def boom(object_key):
            raise RuntimeError("NoSuchKey")

        monkeypatch.setattr(app_storage, "open_object", boom)

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "thumbnail",
                "token": issue_token(UUID(created["id"]), "thumbnail"),
            },
        )

        assert resp.status_code == 404

    def test_a_hostile_filename_cannot_break_out_of_the_header(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """`filename` is whatever the user uploaded, and it lands in a header.

        A quote or a CRLF in there would end the header early and let a caller
        invent headers of its own — so the sanitised fallback carries only
        characters that cannot, and the RFC 6266 form is percent-encoded.
        """
        from app.services.media_tokens import issue_token

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._fake_storage(monkeypatch, b"x")
        # Rewrite the stored name to the classic header-injection payload.
        from app.models.document import DocumentDB

        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(created["id"]))
            .one()
        )
        row.filename = 'evil"; x=1\r\nX-Injected: yes'
        db_session.commit()

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "original",
                "token": issue_token(UUID(created["id"]), "original"),
            },
        )

        assert resp.status_code == 200
        header = resp.headers["content-disposition"]
        assert "\r" not in header and "\n" not in header
        assert "X-Injected" not in resp.headers

    def test_a_path_separator_in_the_filename_is_encoded_not_passed_through(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """``quote`` leaves "/" alone by default, and that is visible here.

        The ASCII fallback hides it — a sanitiser turns "../../etc/passwd" into
        ".._.._etc_passwd", so checking only the fallback proves nothing about
        the encoded parameter the browser actually prefers. "/" is not an
        ext-value character (RFC 5987), so leaving it raw hands the browser a
        suggested filename containing a directory.
        """
        from app.models.document import DocumentDB
        from app.services.media_tokens import issue_token

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        self._fake_storage(monkeypatch, b"x")
        row = (
            db_session.query(DocumentDB)
            .filter(DocumentDB.id == UUID(created["id"]))
            .one()
        )
        row.filename = "../../etc/passwd"
        db_session.commit()

        resp = client.get(
            f"/v1/documents/{created['id']}/content",
            params={
                "kind": "original",
                "token": issue_token(UUID(created["id"]), "original"),
            },
        )

        assert resp.status_code == 200
        header = resp.headers["content-disposition"]
        assert "filename*=UTF-8''..%2F..%2Fetc%2Fpasswd" in header
        assert "filename*=UTF-8''../../" not in header


class TestPreviewDocument:
    """GET /documents/{id}/preview extracts text from the stored object."""

    @staticmethod
    def _fake_body(content: bytes):
        from types import SimpleNamespace

        # `download` is consumed via `with` in the service, so the fake needs
        # both `read` and `close` like the real streaming body.
        return SimpleNamespace(read=lambda: content, close=lambda: None)

    def test_returns_extracted_text(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        monkeypatch.setattr(
            app_storage, "download", lambda _k: self._fake_body(b"Hello preview world")
        )

        resp = client.get(f"/v1/documents/{created['id']}/preview", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == created["id"]
        assert body["filename"] == UPLOAD_FILENAME
        assert body["preview"] == "Hello preview world"
        assert body["truncated"] is False

    def test_truncates_long_text(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        long_text = b"x" * 6000
        monkeypatch.setattr(
            app_storage, "download", lambda object_key: self._fake_body(long_text)
        )

        resp = client.get(f"/v1/documents/{created['id']}/preview", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["truncated"] is True
        assert len(body["preview"]) == 5000
        assert body["preview"] == "x" * 5000

    def test_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.get(f"/v1/documents/{uuid4()}/preview", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_ownership_isolation(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        other_headers = _register_second_user(client)

        resp = client.get(f"/v1/documents/{created['id']}/preview", headers=other_headers)

        assert resp.status_code == 404

    def test_storage_failure_returns_503(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        monkeypatch.setattr(
            app_storage,
            "download",
            lambda object_key: (_ for _ in ()).throw(RuntimeError("s3 down")),
        )

        resp = client.get(f"/v1/documents/{created['id']}/preview", headers=auth_headers)

        assert resp.status_code == 503
        assert resp.json()["error"]["code"] == "service_unavailable"

    def test_ready_document_preview_built_from_chunks(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """READY documents are previewed from chunks — no storage read."""
        from uuid import uuid4

        from app.models.chunk import DocumentChunk
        from app.models.document import DocumentDB, DocumentStatus
        from app.models.user import UserDB
        from app.storage.storage import storage as app_storage

        # Register + login a dedicated user so the doc owner matches the token.
        username = f"chunk_owner_{uuid4().hex[:8]}"
        password = "testpass123"
        register = client.post(
            "/v1/auth/register",
            json={
                "username": username,
                "password": password,
                "confirm_password": password,
            },
        )
        assert register.status_code == 201, register.text
        login = client.post(
            "/v1/auth/login",
            data={"username": username, "password": password},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        owner = db_session.query(UserDB).filter(UserDB.username == username).one()

        doc = DocumentDB(
            owner_id=owner.id,
            filename="chunked.txt",
            object_key="k/chunked.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        # Two overlapping windows, exactly like ChunkingService emits:
        # chunk_b begins with the tail of chunk_a (sliding-window overlap).
        tail = "over the lazy dog. "
        chunk_a = "The quick brown fox jumps " + tail
        chunk_b = tail + "Paid in full: analysis complete."
        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id, content=chunk_a, chunk_index=0
                ),
                DocumentChunk(
                    document_id=doc.id, content=chunk_b, chunk_index=1
                ),
            ]
        )
        db_session.commit()

        download = MagicMock()
        monkeypatch.setattr(app_storage, "download", download)

        resp = client.get(f"/v1/documents/{doc.id}/preview", headers=headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["preview"] == (
            "The quick brown fox jumps over the lazy dog. Paid in full: analysis complete."
        )
        assert body["truncated"] is False
        # The storage download was never touched.
        download.assert_not_called()

    def test_ready_document_without_chunks_falls_back_to_storage(
        self, client, auth_headers, db_session, monkeypatch
    ):
        """A READY document with no chunks still serves from storage."""
        from uuid import uuid4

        from app.models.document import DocumentDB, DocumentStatus
        from app.models.user import UserDB
        from app.storage.storage import storage as app_storage

        # Register + login a dedicated user so the doc owner matches the token.
        username = f"fb_owner_{uuid4().hex[:8]}"
        password = "testpass123"
        register = client.post(
            "/v1/auth/register",
            json={
                "username": username,
                "password": password,
                "confirm_password": password,
            },
        )
        assert register.status_code == 201, register.text
        login = client.post(
            "/v1/auth/login",
            data={"username": username, "password": password},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        owner = db_session.query(UserDB).filter(UserDB.username == username).one()

        doc = DocumentDB(
            owner_id=owner.id,
            filename="legacy.txt",
            object_key="k/legacy.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.commit()

        monkeypatch.setattr(
            app_storage,
            "download",
            lambda _k: self._fake_body(b"legacy stored text"),
        )

        resp = client.get(f"/v1/documents/{doc.id}/preview", headers=headers)

        assert resp.status_code == 200
        assert resp.json()["preview"] == "legacy stored text"

    def test_chunked_preview_truncates_at_limit(
        self, client, auth_headers, db_session
    ):
        from uuid import uuid4

        from app.models.chunk import DocumentChunk
        from app.models.document import DocumentDB, DocumentStatus
        from app.models.user import UserDB

        # Register + login a dedicated user so the doc owner matches the token.
        username = f"long_owner_{uuid4().hex[:8]}"
        password = "testpass123"
        register = client.post(
            "/v1/auth/register",
            json={
                "username": username,
                "password": password,
                "confirm_password": password,
            },
        )
        assert register.status_code == 201, register.text
        login = client.post(
            "/v1/auth/login",
            data={"username": username, "password": password},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        owner = db_session.query(UserDB).filter(UserDB.username == username).one()

        doc = DocumentDB(
            owner_id=owner.id,
            filename="long.txt",
            object_key="k/long.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id,
                    content="y" * 1000,
                    chunk_index=i,
                )
                for i in range(8)  # ~6600 chars after de-overlap
            ]
        )
        db_session.commit()

        resp = client.get(f"/v1/documents/{doc.id}/preview", headers=headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["truncated"] is True
        assert len(body["preview"]) == 5000
        assert body["preview"] == "y" * 5000


def _create_document(client, headers, filename=UPLOAD_FILENAME, content=b"hello world"):
    """Upload a document and return its response body (assumes upload works)."""
    resp = _post_upload(client, headers, content=content, filename=filename)
    assert resp.status_code == 201, f"upload failed: {resp.text}"
    return resp.json()


def _post_bulk_upload(client, headers, files):
    """Post a bulk upload where ``files`` is a list of (filename, content, mime)."""
    payload = [
        ("files", (filename, content, content_type))
        for filename, content, content_type in files
    ]
    return client.post("/v1/documents/bulk", files=payload, headers=headers)


class TestBulkUpload:
    def test_requires_auth(self, client):
        resp = client.post("/v1/documents/bulk")
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "unauthorized"

    def test_rejects_empty_batch(self, client, auth_headers):
        resp = client.post("/v1/documents/bulk", files=[], headers=auth_headers)
        assert resp.status_code == 400
        assert "No files provided" in resp.json()["error"]["message"]

    def test_all_files_uploaded(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)

        resp = _post_bulk_upload(
            client,
            auth_headers,
            [
                ("a.txt", b"alpha", "text/plain"),
                ("b.txt", b"beta", "text/plain"),
            ],
        )

        assert resp.status_code == 201
        body = resp.json()
        assert len(body["uploaded"]) == 2
        assert len(body["failed"]) == 0
        filenames = {doc["filename"] for doc in body["uploaded"]}
        assert filenames == {"a.txt", "b.txt"}
        assert all(doc["status"] == "pending" for doc in body["uploaded"])

    def test_partial_success_reports_per_file_failures(
        self, client, auth_headers, monkeypatch
    ):
        _mock_upload_ok(monkeypatch)

        resp = _post_bulk_upload(
            client,
            auth_headers,
            [
                ("ok.txt", b"good", "text/plain"),
                ("virus.exe", b"bad", "application/octet-stream"),
                ("empty.txt", b"", "text/plain"),
            ],
        )

        assert resp.status_code == 201
        body = resp.json()
        assert len(body["uploaded"]) == 1
        assert body["uploaded"][0]["filename"] == "ok.txt"
        assert len(body["failed"]) == 2
        errors_by_file = {item["filename"]: item["error"] for item in body["failed"]}
        assert "virus.exe" in errors_by_file
        assert "Unsupported file type" in errors_by_file["virus.exe"]
        assert "empty.txt" in errors_by_file
        assert "empty" in errors_by_file["empty.txt"].lower()

    def test_storage_failure_isolated_to_one_file(
        self, client, auth_headers, monkeypatch
    ):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        calls = {"count": 0}

        def flaky_upload(**kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise RuntimeError("s3 hiccup")
            return None

        monkeypatch.setattr(app_storage, "upload", flaky_upload)
        monkeypatch.setattr(document_module, "process_document_task", lambda _id: None)

        resp = _post_bulk_upload(
            client,
            auth_headers,
            [
                ("first.txt", b"one", "text/plain"),
                ("second.txt", b"two", "text/plain"),
            ],
        )

        assert resp.status_code == 201
        body = resp.json()
        assert len(body["uploaded"]) == 1
        assert body["uploaded"][0]["filename"] == "second.txt"
        assert len(body["failed"]) == 1
        assert body["failed"][0]["filename"] == "first.txt"
        assert "temporarily unavailable" in body["failed"][0]["error"]

    def test_exceeding_batch_limit_returns_400(self, client, auth_headers, monkeypatch):
        _mock_upload_ok(monkeypatch)

        files = [(f"doc{i}.txt", b"x", "text/plain") for i in range(21)]

        resp = _post_bulk_upload(client, auth_headers, files)

        assert resp.status_code == 400
        assert "Too many files" in resp.json()["error"]["message"]

    def test_all_failed_still_returns_201_with_empty_uploaded(
        self, client, auth_headers, monkeypatch
    ):
        # Every file is invalid; the batch still completes with per-file errors.
        resp = _post_bulk_upload(
            client,
            auth_headers,
            [
                ("bad1.exe", b"x", "application/octet-stream"),
                ("bad2.exe", b"y", "application/octet-stream"),
            ],
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["uploaded"] == []
        assert len(body["failed"]) == 2