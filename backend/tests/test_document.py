"""Tests for document upload validation and the upload endpoint.

Storage (MinIO) and the worker queue are always mocked — no real
external services are contacted.
"""

from unittest.mock import MagicMock


class TestUploadValidation:
    def _post(self, client, headers, content=b"hello world", filename="notes.txt",
              content_type="text/plain"):
        return client.post(
            "/v1/documents/",
            files={"upload_file": (filename, content, content_type)},
            headers=headers,
        )

    def test_upload_success_returns_201(self, client, auth_headers, monkeypatch):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        enqueued = MagicMock()
        monkeypatch.setattr(document_module, "process_document_task", enqueued)

        resp = self._post(client, auth_headers)

        assert resp.status_code == 201
        body = resp.json()
        assert body["status"] == "pending"
        assert body["filename"] == "notes.txt"
        enqueued.assert_called_once()

    def test_rejects_unsupported_extension(self, client, auth_headers):
        resp = self._post(
            client,
            auth_headers,
            content=b"evil",
            filename="malware.exe",
            content_type="application/octet-stream",
        )
        assert resp.status_code == 400
        assert "Unsupported file type" in resp.json()["detail"]

    def test_rejects_unsupported_content_type(self, client, auth_headers):
        resp = self._post(
            client, auth_headers, filename="notes.txt", content_type="application/x-msdownload"
        )
        assert resp.status_code == 400
        assert "Unsupported file type" in resp.json()["detail"]

    def test_rejects_oversized_file(self, client, auth_headers):
        # 25 MB + 1 byte
        big = b"a" * (25 * 1024 * 1024 + 1)
        resp = self._post(client, auth_headers, content=big, filename="big.txt")
        assert resp.status_code == 413
        assert "too large" in resp.json()["detail"].lower()

    def test_rejects_empty_file(self, client, auth_headers):
        resp = self._post(client, auth_headers, content=b"", filename="empty.txt")
        assert resp.status_code == 400
        assert "empty" in resp.json()["detail"].lower()

    def test_rejects_invalid_filename(self, client, auth_headers):
        resp = self._post(client, auth_headers, filename="..")
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Invalid filename"

    def test_sanitizes_control_characters_in_filename(
        self, client, auth_headers, monkeypatch
    ):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        monkeypatch.setattr(
            document_module, "process_document_task", lambda _id: None
        )

        resp = self._post(
            client, auth_headers, filename="bad\x00name.txt", content_type="text/plain"
        )

        assert resp.status_code == 201
        assert resp.json()["filename"] == "badname.txt"

    def test_octet_stream_accepted_when_extension_valid(
        self, client, auth_headers, monkeypatch
    ):
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        monkeypatch.setattr(
            document_module, "process_document_task", lambda _id: None
        )

        resp = self._post(
            client, auth_headers, filename="notes.txt", content_type="application/octet-stream"
        )
        assert resp.status_code == 201