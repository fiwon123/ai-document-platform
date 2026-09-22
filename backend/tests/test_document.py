"""Tests for document endpoints: upload, list, get, delete, download.

Storage (MinIO) and the worker queue are always mocked — no real
external services are contacted.
"""

from unittest.mock import MagicMock

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
        assert len(deleted) == 1
        # The row is gone from the database too.
        assert client.get(f"/v1/documents/{doc_id}", headers=auth_headers).status_code == 404

    def test_delete_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.delete(f"/v1/documents/{uuid4()}", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

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


class TestDownloadDocument:
    def test_returns_presigned_url(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)

        monkeypatch.setattr(
            app_storage,
            "create_download_url",
            lambda object_key, expires_in: f"https://storage.example/{object_key}",
        )

        resp = client.get(f"/v1/documents/{created['id']}/download", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert body["filename"] == UPLOAD_FILENAME
        assert body["download_url"].startswith("https://storage.example/")

    def test_404_for_missing_document(self, client, auth_headers):
        from uuid import uuid4

        resp = client.get(f"/v1/documents/{uuid4()}/download", headers=auth_headers)

        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "not_found"

    def test_ownership_isolation(self, client, auth_headers, monkeypatch):
        from app.storage.storage import storage as app_storage

        _mock_upload_ok(monkeypatch)
        created = _create_document(client, auth_headers)
        other_headers = _register_second_user(client)

        monkeypatch.setattr(app_storage, "create_download_url", lambda *a, **k: "https://x")
        resp = client.get(f"/v1/documents/{created['id']}/download", headers=other_headers)

        assert resp.status_code == 404


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
        original_upload = app_storage.upload

        def flaky_upload(**kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise RuntimeError("s3 hiccup")
            return original_upload(**kwargs)

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