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
import ipaddress
import json
import logging
import secrets
import socket
import threading
from collections.abc import Callable
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

# --- SSRF protection for receiver URLs -------------------------------------
#
# Webhook subscriptions POST signed payloads to user-supplied URLs, so the
# URL must never point at loopback, link-local, private, reserved, or
# cloud-metadata addresses — otherwise a user could pivot the server into
# the internal network or exfiltrate cloud IAM credentials. Both IP-literal
# URLs and hostnames (resolved at subscription time) are checked.

# IPv4 networks that must never be webhook delivery targets. Kept explicit
# rather than relying on ``ipaddress.is_private`` so new IANA special-use
# assignments are covered regardless of the stdlib version in use.
_UNSAFE_IPV4_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),        # "this" network
    ipaddress.ip_network("10.0.0.0/8"),       # RFC 1918 private
    ipaddress.ip_network("100.64.0.0/10"),    # CGNAT
    ipaddress.ip_network("127.0.0.0/8"),      # loopback
    ipaddress.ip_network("169.254.0.0/16"),   # link-local (incl. cloud metadata)
    ipaddress.ip_network("172.16.0.0/12"),    # RFC 1918 private
    ipaddress.ip_network("192.0.0.0/24"),     # IETF protocol assignments
    ipaddress.ip_network("192.0.2.0/24"),     # TEST-NET-1
    ipaddress.ip_network("192.168.0.0/16"),   # RFC 1918 private
    ipaddress.ip_network("198.18.0.0/15"),    # benchmarking
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),   # TEST-NET-3
    ipaddress.ip_network("224.0.0.0/4"),      # multicast
    ipaddress.ip_network("240.0.0.0/4"),      # reserved
]

_UNSAFE_IPV6_NETWORKS = [
    ipaddress.ip_network("::/128"),           # unspecified
    ipaddress.ip_network("::1/128"),          # loopback
    ipaddress.ip_network("fc00::/7"),         # unique local (private)
    ipaddress.ip_network("fe80::/10"),        # link-local
    ipaddress.ip_network("ff00::/8"),         # multicast
    ipaddress.ip_network("2001:db8::/32"),    # documentation
]

# Hostnames that conventionally never resolve to a public, externally
# reachable address. ``*.local``/``*.internal``-style names may not resolve
# at all in the server's resolver, so they are rejected by name alone.
_INTERNAL_HOSTNAMES = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
        "metadata.aws.internal",
    }
)
_INTERNAL_HOSTNAME_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".home.arpa",
    ".lan",
    ".localdomain",
    ".corp",
)


def _is_unsafe_ip(address: ipaddress._BaseAddress) -> bool:
    """True when ``address`` falls in a network that must never be a target."""
    networks = (
        _UNSAFE_IPV4_NETWORKS if isinstance(address, ipaddress.IPv4Address)
        else _UNSAFE_IPV6_NETWORKS
    )
    return any(address in network for network in networks)


def _resolve_host(host: str) -> list[ipaddress._BaseAddress]:
    """Resolve a hostname to its IP addresses (integration-resolvable hook)."""
    try:
        infos = socket.getaddrinfo(
            host, None, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
        )
    except socket.gaierror:
        return []
    addresses: list[ipaddress._BaseAddress] = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    return addresses


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


def is_valid_webhook_url(
    url: str,
    *,
    resolver: Callable[[str], list[ipaddress._BaseAddress]] | None = None,
) -> bool:
    """Return True only for http(s) URLs that target a public, non-internal
    address (SSRF guard).

    The check is layered:

    - scheme/netloc sanity (``http``/``https`` only);
    - a hostname blocklist (``localhost``, ``*.local``, ``*.internal``,
      cloud-metadata hostnames, ...);
    - IP-literal URLs are rejected when the literal falls in any unsafe
      network (loopback, link-local, RFC 1918, CGNAT, multicast, ...);
    - hostnames are resolved and rejected when any resolved address is
      unsafe, or when the name does not resolve at all.

    ``resolver`` is injectable for tests (defaults to the real resolver).
    """
    try:
        parsed = urlparse(url)
        host = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not host:
        return False

    lowered = host.lower()
    if lowered in _INTERNAL_HOSTNAMES or any(
        lowered.endswith(suffix) for suffix in _INTERNAL_HOSTNAME_SUFFIXES
    ):
        return False

    # IP literals are checked directly; hostnames go through the resolver.
    try:
        address = ipaddress.ip_address(lowered)
    except ValueError:
        address = None

    if address is not None:
        return not _is_unsafe_ip(address)

    lookup = resolver if resolver is not None else _resolve_host
    resolved = lookup(lowered)
    if not resolved:
        return False
    return not any(_is_unsafe_ip(item) for item in resolved)


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
    # Defense in depth: the URL was validated at subscription time, but
    # re-check before posting so a DNS rebinding change cannot redirect a
    # payload into the internal network.
    if not is_valid_webhook_url(subscription.url):
        logger.warning(
            "Blocked webhook delivery to unsafe URL: %s", subscription.url
        )
        return False, None
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
    if not is_valid_webhook_url(subscription.url):
        return False, None, "Webhook URL is not a valid public http(s) endpoint"
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