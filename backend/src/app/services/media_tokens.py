"""Short-lived signed tokens for document bytes the browser has to fetch (#536).

## Why this exists

The documents page renders each PDF's first page with an ``<img src>``, and
that attribute cannot carry an ``Authorization`` header — which is why the
endpoints used to hand out *presigned storage URLs* instead of bytes. A
presigned URL solves the header problem by moving the authorisation into the
URL, and it works, right up to the point where the browser cannot resolve the
storage host.

That is not an edge case. The URL is generated from
``MINIO_PUBLIC_ENDPOINT``, which is a **guess about where the browser is** and
nothing more:

- a browser on the developer's host needs the published port
  (``localhost:9000``)
- a browser inside the dev container — the audit's Chromium, a Vite preview, a
  colleague sharing a tunnel — needs ``minio:9000``
- a browser outside a Kubernetes cluster needs whatever the Ingress for the
  object store is called, which is a different name again per environment

So there is no default that is correct everywhere, and the wrong one fails
**silently**: the image request dies with ``net::ERR_CONNECTION_REFUSED`` and the
card falls back to its type chip, which looks like a missing feature rather than
a misconfiguration. That is precisely what happened — a whole audit pass
photographed the documents page with no previews at all (#536).

## What this does instead

The API serves the bytes, and authorises the request with a token *in the URL*,
because the URL is the only place an ``<img src>`` can put a secret. The token
is an HMAC over the document id, the kind of asset and an expiry, signed with
the application's own ``SECRET_KEY``, so:

- it needs no storage client on the browser side, and no configuration guessing:
  the URL is a path on the API origin, which the browser can already reach
  because every other request goes there;
- it grants one document, one kind of asset, for fifteen minutes, and nothing
  else — a leaked link is not a leaked bucket;
- it cannot be edited to reach another document, another kind, or to outlive
  its window, because each of those is inside the signed message.

## Why the same key as the JWT

``SECRET_KEY`` already signs access tokens, so reusing it adds no new secret and
no new rotation story. The message format is deliberately *not* a JWT: a token
nobody should be able to parse or replay is a smaller surface than a general
format, and a failure here must be a 403 with no explanation rather than a
decoder error.
"""

import hashlib
import hmac
import os
import time
from uuid import UUID

# Long enough that a page left open overnight does not lose its previews on
# every card at once, short enough that a URL pasted into a chat or a proxy log
# is dead by the next morning. Presigned storage URLs were an hour; this is
# deliberately less, because unlike a storage URL this one is our own to choose.
MEDIA_TOKEN_TTL_SECONDS = 900

# Read the way `app.routes.auth` reads it, at import time. That module also
# calls `ensure_secret_key_acceptable` on the same value, so in a running app the
# key is known to be a real one before anything here can sign with it.
SECRET_KEY = os.getenv("SECRET_KEY", "")

# The two assets a browser fetches by URL. Enumerated rather than free-form, so
# a token issued for a thumbnail cannot be replayed against the original file.
KIND_THUMBNAIL = "thumbnail"
KIND_ORIGINAL = "original"
MEDIA_KINDS = (KIND_ORIGINAL, KIND_THUMBNAIL)


def _message(document_id: UUID | str, kind: str, expires_at: int) -> bytes:
    """The exact bytes that are signed. Order and separators are load-bearing."""
    return f"{kind}:{document_id}:{expires_at}".encode()


def _signature(
    document_id: UUID | str,
    kind: str,
    expires_at: int,
    secret: str | bytes | None = None,
) -> str:
    key = SECRET_KEY if secret is None else secret
    if isinstance(key, str):
        key = key.encode()
    digest = hmac.new(key, _message(document_id, kind, expires_at), hashlib.sha256)
    return digest.hexdigest()


def issue_token(
    document_id: UUID,
    kind: str,
    *,
    ttl_seconds: int = MEDIA_TOKEN_TTL_SECONDS,
    now: float | None = None,
) -> str:
    """Return a token authorising ``kind`` of ``document_id`` for ``ttl_seconds``.

    ``now`` is injectable so the expiry tests do not have to sleep.
    """
    if kind not in MEDIA_KINDS:
        raise ValueError(f"unknown media kind: {kind!r}")
    issued_at = int(time.time() if now is None else now)
    expires_at = issued_at + int(ttl_seconds)
    return f"{expires_at}.{_signature(document_id, kind, expires_at)}"


def verify_token(
    token: str,
    document_id: UUID,
    kind: str,
    *,
    now: float | None = None,
) -> bool:
    """True when ``token`` is ours, unexpired, and for this document and kind.

    Fails closed at every step: a malformed token, a wrong separator, a missing
    expiry and a signature mismatch are all simply ``False``. A caller that
    cannot tell *why* must not be tempted to tell the requester either.
    """
    if not token or kind not in MEDIA_KINDS:
        return False
    try:
        raw_expiry, _, signature = token.partition(".")
        if not raw_expiry or not signature:
            return False
        expires_at = int(raw_expiry)
    except (TypeError, ValueError):
        return False

    current = time.time() if now is None else now
    if expires_at <= int(current):
        return False

    expected = _signature(document_id, kind, expires_at)
    # compare_digest, not ==: a length-independent comparison would leak how
    # much of a forged signature was right, and there is no reason to accept
    # that cost on a value that guards a user's documents.
    return hmac.compare_digest(expected, signature)
