"""Webhook delivery: document lifecycle events POSTed to user endpoints.

Payments are signed with an HMAC-SHA256 digest of the raw request body
using the subscription's per-user secret, so receivers can verify
authenticity (the ``X-Webhook-Signature`` header). Delivery is
best-effort by design: transient failures are retried a few times with
backoff, and persistent failures are recorded on the subscription row —
they never fail or delay the document pipeline that triggered them.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse
from uuid import UUID

import httpx

from app.database.db import SessionLocal
from app.models.document import DocumentDB
from app.models.webhook import WebhookSubscription
from app.repositories.webhook import WebhookRepository
from app.schemas.webhook import WebhookEvent

logger = logging.getLogger(__name__)

# Delivery retries: up to 3 attempts with short exponential backoff so a
# transient receiver hiccup is absorbed without hammering the endpoint.
MAX_DELIVERY_ATTEMPTS = 3
DELIVERY_BACKOFF_SECONDS = 1
DELIVERY_TIMEOUT_SECONDS = 10

SIGNATURE_HEADER = "X-Webhook-Signature"
EVENT_HEADER = "X-Webhook-Event"


@dataclass(frozen=True)
class DocumentEventInfo:
    """Plain-value snapshot of a document for webhook payloads.

    Built eagerly from an ORM instance while its session is open (see
    ``document_event_info``), so the background delivery task only ever
    touches detached-safe primitives — never expired ORM attributes.
    """

    document_id: UUID
    filename: str
    status: str
    owner_id: UUID


def document_event_info(document: DocumentDB) -> DocumentEventInfo:
    """Snapshot the document fields a webhook payload needs, eagerly."""
    return DocumentEventInfo(
        document_id=document.id,
        filename=document.filename,
        status=(
            document.status.value
            if hasattr(document.status, "value")
            else str(document.status)
        ),
        owner_id=document.owner_id,
    )


def generate_secret() -> str:
    """Generate a fresh, URL-safe signing secret for a subscription."""
    return secrets.token_urlsafe(32)


def sign_payload(secret: str, body: bytes) -> str:
    """HMAC-SHA256 hexdigest of the raw body using the subscription secret."""
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def is_valid_webhook_url(url: str) -> bool:
    """Accept only parseable http/https URLs (rejects SSRF-prone schemes)."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def build_payload(event: str, info: DocumentEventInfo) -> dict:
    """Assemble the JSON payload delivered for a document event.

    ``info`` must be a plain-value snapshot (see ``document_event_info``);
    the payload may be built well after the originating ORM session closed.
    """
    payload = {
        "event": event,
        "created_at": datetime.now(UTC).isoformat(),
        "payload": {
            "document_id": str(info.document_id),
            "filename": info.filename,
        },
    }
    if event != WebhookEvent.DELETED.value:
        # The row still exists for processing events; include the status so
        # receivers do not need to re-fetch it. Deleted documents are gone.
        payload["payload"]["status"] = info.status
    return payload


async def _post_payload(
    client: httpx.AsyncClient,
    url: str,
    body: bytes,
    signature: str,
    event: str,
) -> httpx.Response:
    """Single POST of a signed payload. Thin wrapper kept for testability."""
    return await client.post(
        url,
        content=body,
        headers={
            "Content-Type": "application/json",
            SIGNATURE_HEADER: signature,
            EVENT_HEADER: event,
            "User-Agent": "ai-document-platform/1.0",
        },
    )


async def _deliver(subscription: WebhookSubscription, payload: dict) -> tuple[bool, int | None]:
    """Deliver a payload with retries; returns ``(delivered, last_status_code)``."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = sign_payload(subscription.secret, body)
    last_status_code: int | None = None
    last_error: str | None = None

    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS) as client:
        for attempt in range(1, MAX_DELIVERY_ATTEMPTS + 1):
            try:
                response = await _post_payload(
                    client,
                    subscription.url,
                    body,
                    signature,
                    payload["event"],
                )
                last_status_code = response.status_code
                if response.status_code < 400:
                    return True, last_status_code
                last_error = f"HTTP {response.status_code}"
            except httpx.HTTPError as e:
                last_error = str(e)
            except Exception as e:  # noqa: BLE001 - any failure is retried
                last_error = str(e)

            if attempt < MAX_DELIVERY_ATTEMPTS:
                await asyncio.sleep(DELIVERY_BACKOFF_SECONDS * (2 ** (attempt - 1)))

    logger.warning(
        f"Webhook delivery to {subscription.url} failed after "
        f"{MAX_DELIVERY_ATTEMPTS} attempts: {last_error}"
    )
    return False, last_status_code


async def dispatch_payload(event: str, owner_id: UUID, payload: dict) -> None:
    """Deliver a pre-built payload to the owner's active subscriptions.

    Only subscriptions subscribed to ``event`` and currently active receive
    the notification. Delivery results are persisted on each subscription;
    failures are logged and swallowed so webhook problems can never break
    the document pipeline that triggered them. ``payload`` must be built
    eagerly by the caller (see dispatch_document_event).
    """
    db = SessionLocal()
    try:
        repository = WebhookRepository(db)
        targets = [
            sub
            for sub in repository.list_for_user(owner_id)
            if sub.is_active and event in (sub.events or [])
        ]
        if not targets:
            return

        results = await asyncio.gather(
            *[_deliver(sub, payload) for sub in targets],
            return_exceptions=True,
        )
        for sub, result in zip(targets, results, strict=False):
            if isinstance(result, Exception):
                success, status_code = False, None
            else:
                success, status_code = result
            repository.record_delivery(sub, success=success, status_code=status_code)
    except Exception as e:  # noqa: BLE001 - delivery must never break callers
        logger.warning(f"Webhook dispatch failed for event {event}: {e}")
    finally:
        db.close()


async def dispatch_document_event(event: str, info: DocumentEventInfo) -> None:
    """Build the payload and dispatch it (async context, e.g. the worker).

    ``info`` is a plain-value snapshot, so building the payload here is
    safe even after the caller's session closed (see dispatch_payload).
    """
    payload = build_payload(event, info)
    await dispatch_payload(event, info.owner_id, payload)


def _build_and_dispatch_sync(event: str, info: DocumentEventInfo) -> None:
    """Build the payload, then dispatch it in a private event loop."""
    payload = build_payload(event, info)
    asyncio.run(dispatch_payload(event, info.owner_id, payload))


def dispatch_document_event_sync(event: str, info: DocumentEventInfo) -> None:
    """Blocking facade for sync callers without an event loop (tests)."""
    try:
        _build_and_dispatch_sync(event, info)
    except Exception as e:  # noqa: BLE001 - delivery is best-effort
        logger.warning(f"Sync webhook dispatch failed for event {event}: {e}")


def fire_webhook_background(event: str, info: DocumentEventInfo) -> None:
    """Fire-and-forget facade for sync callers (routes, fallback worker).

    The payload is built here from the detached-safe snapshot; delivery
    runs in a daemon thread so the request never blocks on receiver
    latency. Retries/timeouts are bounded inside the dispatch; the thread
    dies with the process, which is fine — notifications are best-effort.
    """
    payload = build_payload(event, info)
    threading.Thread(
        target=asyncio.run,
        args=(dispatch_payload(event, info.owner_id, payload),),
        daemon=True,
        name=f"webhook-{event}",
    ).start()


async def deliver_test_payload(
    subscription: WebhookSubscription,
) -> tuple[bool, int | None, str]:
    """Send a single ``ping`` payload to verify a receiver endpoint.

    Used by ``POST /v1/webhooks/{id}/test`` — a single attempt keeps the
    check snappy; the receiver either answers or the user sees the error.
    """
    payload = {
        "event": "ping",
        "created_at": datetime.now(UTC).isoformat(),
        "payload": {
            "message": "This is a test notification from AI Document Intelligence Platform",
        },
    }
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = sign_payload(subscription.secret, body)
    try:
        async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS) as client:
            response = await _post_payload(
                client,
                subscription.url,
                body,
                signature,
                "ping",
            )
            delivered = response.status_code < 400
            message = "Delivered" if delivered else f"HTTP {response.status_code}"
            return delivered, response.status_code, message
    except Exception as e:  # noqa: BLE001 - report the failure to the caller
        return False, None, str(e)