"""Tests for webhook subscriptions: CRUD endpoints, signing, and delivery.

Database-backed tests follow the suite conventions (they skip when
PostgreSQL is unavailable). External HTTP delivery is always mocked via
``app.services.webhook._post_payload`` / ``_deliver`` — no real endpoints
are contacted.
"""

import asyncio
import ipaddress
import uuid
from unittest.mock import MagicMock

from app.schemas.webhook import WebhookEvent

TEST_URL = "https://example.com/hook"


def _create_subscription(client, headers, url=TEST_URL, events=None):
    events = [WebhookEvent.READY.value] if events is None else events
    return client.post(
        "/v1/webhooks/",
        json={"url": url, "events": events},
        headers=headers,
    )


def _register_second_user(client) -> dict:
    """Register + login a second unique user for isolation tests."""
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


def _current_user_id(client, headers) -> str:
    me = client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200, me.text
    return me.json()["id"]


class TestSigningHelpers:
    """Pure unit tests — no database or external services involved."""

    def test_sign_payload_is_deterministic_and_secret_dependent(self):
        from app.services.webhook import sign_payload

        body = b'{"event": "document.ready"}'
        sig_a1 = sign_payload("secret-a", body)
        sig_a2 = sign_payload("secret-a", body)
        sig_b = sign_payload("secret-b", body)
        assert sig_a1 == sig_a2
        assert sig_a1 != sig_b
        assert len(sig_a1) == 64  # sha256 hex digest

    def test_generate_secret_is_unique_and_usable(self):
        from app.services.webhook import generate_secret

        secret_a = generate_secret()
        secret_b = generate_secret()
        assert secret_a
        assert secret_a != secret_b

    def test_mask_secret_hides_full_value(self):
        from app.services.webhook import mask_secret

        secret = "AbCdEfGh1234567890"
        hidden = mask_secret(secret)
        assert hidden != secret
        assert "..." in hidden
        assert hidden == f"{secret[:5]}...{secret[-4:]}"
        # Very short secrets degrade to a fully opaque placeholder.
        assert mask_secret("short") == "hwk...hidden"

    def test_url_validation(self):
        from app.services.webhook import is_valid_webhook_url

        assert is_valid_webhook_url("https://example.com/hook")
        assert is_valid_webhook_url("https://example.com:8443/hook")
        assert not is_valid_webhook_url("ftp://example.com/hook")
        assert not is_valid_webhook_url("javascript:alert(1)")
        assert not is_valid_webhook_url("")
        assert not is_valid_webhook_url("not a url")

    def test_url_validation_rejects_internal_addresses(self):
        """Loopback, private, link-local, metadata, and special-use ranges."""
        from app.services.webhook import is_valid_webhook_url

        for url in (
            "http://localhost:8080/hook",
            "http://127.0.0.1:8080/hook",
            "http://[::1]:8080/hook",
            "http://10.0.0.5/hook",
            "http://172.16.0.1/hook",
            "http://192.168.1.10/hook",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/hook",
            "http://0.0.0.0/hook",
            "http://[fc00::1]/hook",
            "http://[fe80::1]/hook",
            "http://myhost.local/hook",
            "http://service.internal/hook",
            "http://metadata.google.internal/hook",
        ):
            assert not is_valid_webhook_url(url), url

    def test_url_validation_accepts_public_ip_literals(self):
        from app.services.webhook import is_valid_webhook_url

        assert is_valid_webhook_url("http://93.184.216.34/hook")
        assert is_valid_webhook_url("https://[2606:2800:220:1:248:1893:25c8:1946]/hook")

    def test_url_validation_uses_resolver_for_hostnames(self):
        """The resolver is injectable so tests avoid real DNS lookups."""
        from app.services.webhook import is_valid_webhook_url

        public = lambda host: [ipaddress.ip_address("93.184.216.34")]  # noqa: E731

        assert is_valid_webhook_url("https://example.com/hook", resolver=public)

        # A hostname that resolves to an internal address is rejected even
        # though the literal name looks public (DNS-rebinding guard).
        rebinding = lambda host: [ipaddress.ip_address("127.0.0.1")]  # noqa: E731
        assert not is_valid_webhook_url(
            "https://rebinding.example/hook", resolver=rebinding
        )

        # Unresolvable hostnames are rejected.
        assert not is_valid_webhook_url(
            "https://unresolvable.example/hook", resolver=lambda host: []
        )

    def test_build_payload_shape(self):
        from app.services.webhook import DocumentEventInfo, build_payload

        info = DocumentEventInfo(
            document_id=uuid.uuid4(),
            filename="a.txt",
            status="ready",
            owner_id=uuid.uuid4(),
        )
        ready = build_payload(WebhookEvent.READY.value, info)
        assert ready["event"] == "document.ready"
        assert ready["payload"]["document_id"] == str(info.document_id)
        assert ready["payload"]["filename"] == "a.txt"
        assert ready["payload"]["status"] == "ready"

        deleted = build_payload(WebhookEvent.DELETED.value, info)
        assert "status" not in deleted["payload"]


class TestWebhookEndpoints:
    def test_create_lists_update_delete_flow(self, client, auth_headers):
        created = _create_subscription(client, auth_headers)
        assert created.status_code == 201
        body = created.json()
        assert body["url"] == TEST_URL
        assert body["events"] == ["document.ready"]
        assert body["is_active"] is True
        assert body["secret"]
        assert body["failure_count"] == 0
        sid = body["id"]

        listing = client.get("/v1/webhooks/", headers=auth_headers)
        assert listing.status_code == 200
        listed = listing.json()
        assert [s["id"] for s in listed] == [sid]

        # Signing secrets are capture-once: the create response carries
        # the full value, listings only a masked form.
        assert listed[0]["secret"] != body["secret"]
        assert listed[0]["secret"] == f"{body['secret'][:5]}...{body['secret'][-4:]}"

        updated = client.put(
            f"/v1/webhooks/{sid}",
            json={
                "url": "https://example.com/other",
                "events": ["document.failed", "document.deleted"],
                "is_active": False,
            },
            headers=auth_headers,
        )
        assert updated.status_code == 200
        ub = updated.json()
        assert ub["url"] == "https://example.com/other"
        assert sorted(ub["events"]) == ["document.deleted", "document.failed"]
        assert ub["is_active"] is False
        # The full secret is never echoed back on update either.
        assert ub["secret"] == listed[0]["secret"]
        assert ub["secret"] != body["secret"]

        deleted = client.delete(f"/v1/webhooks/{sid}", headers=auth_headers)
        assert deleted.status_code == 204
        assert client.get("/v1/webhooks/", headers=auth_headers).json() == []

    def test_create_rejects_invalid_url(self, client, auth_headers):
        resp = _create_subscription(client, auth_headers, url="ftp://example.com/hook")
        assert resp.status_code == 422

    def test_create_rejects_internal_url(self, client, auth_headers):
        """SSRF guard: private/metadata URLs are rejected at subscription time."""
        resp = _create_subscription(
            client,
            auth_headers,
            url="http://169.254.169.254/latest/meta-data/",
        )
        assert resp.status_code == 422
        assert "public" in resp.json()["error"]["message"]

    def test_create_rejects_empty_events(self, client, auth_headers):
        resp = _create_subscription(client, auth_headers, events=[])
        assert resp.status_code == 422

    def test_update_rejects_invalid_url(self, client, auth_headers):
        sid = _create_subscription(client, auth_headers).json()["id"]
        resp = client.put(
            f"/v1/webhooks/{sid}",
            json={"url": "not a url"},
            headers=auth_headers,
        )
        assert resp.status_code == 422

    def test_ownership_isolation(self, client, auth_headers):
        created = _create_subscription(client, auth_headers)
        sid = created.json()["id"]
        other = _register_second_user(client)

        listed = client.get("/v1/webhooks/", headers=other)
        assert listed.status_code == 200
        assert listed.json() == []

        assert (
            client.put(f"/v1/webhooks/{sid}", json={"is_active": False}, headers=other).status_code
            == 404
        )
        assert client.delete(f"/v1/webhooks/{sid}", headers=other).status_code == 404
        assert client.post(f"/v1/webhooks/{sid}/test", headers=other).status_code == 404

    def test_test_endpoint_delivers_ping_and_records_result(
        self, client, auth_headers, monkeypatch
    ):
        created = _create_subscription(client, auth_headers)
        sid = created.json()["id"]

        from app.services import webhook as webhook_module

        sent = {}

        async def fake_post(client_inst, url, body, signature, event):
            sent["url"] = url
            sent["signature"] = signature
            sent["event"] = event
            sent["body"] = body
            response = MagicMock()
            response.status_code = 200
            return response

        monkeypatch.setattr(webhook_module, "_post_payload", fake_post)

        resp = client.post(f"/v1/webhooks/{sid}/test", headers=auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert body["delivered"] is True
        assert body["event"] == "ping"
        assert sent["url"] == TEST_URL

        # The signature must verify against the subscription's secret and
        # the exact raw body the receiver got.
        from app.services.webhook import sign_payload

        assert sent["signature"] == sign_payload(created.json()["secret"], sent["body"])

        listing = client.get("/v1/webhooks/", headers=auth_headers).json()
        assert listing[0]["last_status"] == "success"
        assert listing[0]["last_status_code"] == 200

    def test_test_endpoint_reports_failure(self, client, auth_headers, monkeypatch):
        sid = _create_subscription(client, auth_headers).json()["id"]

        from app.services import webhook as webhook_module

        async def fake_post(client_inst, url, body, signature, event):
            raise RuntimeError("connection refused")

        monkeypatch.setattr(webhook_module, "_post_payload", fake_post)

        resp = client.post(f"/v1/webhooks/{sid}/test", headers=auth_headers)
        body = resp.json()
        assert body["delivered"] is False
        assert "connection refused" in body["message"]

        listing = client.get("/v1/webhooks/", headers=auth_headers).json()
        assert listing[0]["last_status"] == "failed"
        assert listing[0]["failure_count"] == 1


class TestEventDispatch:
    def test_delivers_only_to_matching_active_subscriptions(
        self, client, auth_headers, monkeypatch
    ):
        ready_id = _create_subscription(
            client, auth_headers, events=["document.ready"]
        ).json()["id"]
        inactive_id = _create_subscription(
            client, auth_headers, events=["document.ready"]
        ).json()["id"]
        client.put(
            f"/v1/webhooks/{inactive_id}",
            json={"is_active": False},
            headers=auth_headers,
        )
        _create_subscription(client, auth_headers, events=["document.failed"])

        from app.services import webhook as webhook_module
        from app.services.webhook import DocumentEventInfo, dispatch_document_event

        delivered = []

        async def fake_deliver(subscription, payload):
            delivered.append((subscription.id, payload["event"]))
            return True, 200

        monkeypatch.setattr(webhook_module, "_deliver", fake_deliver)

        info = DocumentEventInfo(
            document_id=uuid.uuid4(),
            filename="a.txt",
            status="ready",
            owner_id=_current_user_id(client, auth_headers),
        )
        asyncio.run(dispatch_document_event(WebhookEvent.READY.value, info))

        # Only the active READY subscription receives the event.
        assert len(delivered) == 1
        assert delivered[0][0] == uuid.UUID(ready_id)
        assert delivered[0][1] == "document.ready"

        # The outcome is recorded on the delivered subscription; the
        # others stay untouched.
        listing = client.get("/v1/webhooks/", headers=auth_headers).json()
        by_id = {s["id"]: s for s in listing}
        assert by_id[ready_id]["last_status"] == "success"
        assert by_id[ready_id]["last_status_code"] == 200
        assert by_id[inactive_id]["last_status"] is None

    def test_delivery_failure_is_recorded_and_never_raises(
        self, client, auth_headers, monkeypatch
    ):
        _create_subscription(client, auth_headers, events=["document.failed"])

        from app.services import webhook as webhook_module
        from app.services.webhook import DocumentEventInfo, dispatch_document_event

        async def failing_deliver(subscription, payload):
            raise RuntimeError("receiver exploded")

        monkeypatch.setattr(webhook_module, "_deliver", failing_deliver)

        info = DocumentEventInfo(
            document_id=uuid.uuid4(),
            filename="a.txt",
            status="failed",
            owner_id=_current_user_id(client, auth_headers),
        )
        # Dispatch must complete without raising.
        asyncio.run(dispatch_document_event(WebhookEvent.FAILED.value, info))

        listing = client.get("/v1/webhooks/", headers=auth_headers).json()
        assert listing[0]["last_status"] == "failed"
        assert listing[0]["failure_count"] == 1

    def test_no_subscriptions_is_a_noop(self, client, auth_headers):
        from app.services.webhook import DocumentEventInfo, dispatch_document_event

        info = DocumentEventInfo(
            document_id=uuid.uuid4(),
            filename="a.txt",
            status="ready",
            owner_id=_current_user_id(client, auth_headers),
        )
        # Nothing subscribed: must complete silently.
        asyncio.run(dispatch_document_event(WebhookEvent.READY.value, info))


class TestDeleteEvent:
    def test_delete_fires_document_deleted_event(self, client, auth_headers, monkeypatch):
        # Storage upload + worker enqueue succeed without external calls
        # (same helper pattern as the document tests).
        from app.services import document as document_module
        from app.storage.storage import storage as app_storage

        monkeypatch.setattr(app_storage, "upload", lambda **kwargs: None)
        monkeypatch.setattr(document_module, "process_document_task", lambda _id: None)
        monkeypatch.setattr(app_storage, "delete", lambda object_key: None)

        fired = []
        fake_fire = lambda event, info: fired.append((event, info))  # noqa: E731
        monkeypatch.setattr(
            "app.services.webhook.fire_webhook_background", fake_fire
        )

        created = client.post(
            "/v1/documents/",
            files={"upload_file": ("notes.txt", b"hello", "text/plain")},
            headers=auth_headers,
        ).json()

        resp = client.delete(f"/v1/documents/{created['id']}", headers=auth_headers)
        assert resp.status_code == 200

        assert len(fired) == 1
        event, info = fired[0]
        assert event == "document.deleted"
        assert str(info.document_id) == created["id"]
        assert info.filename == "notes.txt"
        assert info.owner_id == uuid.UUID(_current_user_id(client, auth_headers))