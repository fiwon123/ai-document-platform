"""HTTP caching: ETag + Cache-Control for a small set of GET endpoints.

Most of the API is user-specific or dynamic and must not be cached. Three
endpoints benefit from explicit caching semantics (see the issue #315
acceptance criteria):

- ``/v1/qa/models``          — static per-process config → long-lived, public
- ``/v1/statistics/me``      — per-user dashboard → store, revalidate always
- ``/v1/documents/{id}/thumbnail`` — time-limited presigned URL → store,
  revalidate always so the returned URL never goes stale and deleted
  documents stop resolving promptly

The ETag is derived from the CURRENT response body on every request, so no
cross-request state is needed: per-user/per-response content stays correct,
and a client's ``If-None-Match`` either matches the fresh body (304) or the
200 carries a new ETag + Cache-Control. Everything else passes through
untouched.
"""

import hashlib
import re
from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

# (path regex, Cache-Control value, weak ETag?)
# Weak ETags are used where the body can legitimately change between
# generations (statistics); strong ETags guarantee byte-identity (models
# list, presigned thumbnail URL — the exact URL string is the payload).
#
# Statistics and thumbnails are per-user responses whose content changes
# the moment the user's document set changes (upload, delete, processing,
# re-render of a thumbnail). They MUST NOT be marked fresh for a fixed
# max-age window — the backend invalidates those caches explicitly, and a
# ``max-age`` directive would let the browser keep serving the stale body
# without ever asking again. ``no-cache`` stores the response but always
# revalidates via the ETag, so unchanged bodies keep the cheap 304 path
# while changed ones are always delivered fresh.
_CACHE_POLICIES: list[tuple[re.Pattern[str], str, bool]] = [
    (
        re.compile(r"^/v1/qa/models$"),
        "public, max-age=3600, immutable",
        False,
    ),
    (
        re.compile(r"^/v1/statistics/me$"),
        "private, no-cache",
        True,
    ),
    (
        # The thumbnail RESPONSE is the presigned URL (valid for 1 h), not
        # the image itself. Revalidating on every use hands out a fresh URL,
        # which also removes a deleted document's cached URL within one
        # revalidation instead of serving it for a 15-minute max-age.
        re.compile(r"^/v1/documents/[0-9a-fA-F-]{36}/thumbnail$"),
        "private, no-cache",
        False,
    ),
]

# The statistics and thumbnail responses are per-user; caches (including the
# browser) must key on the Authorization header so one user's data can never
# be served to another from a shared cache.


def _match_policy(path: str) -> tuple[str, bool] | None:
    for pattern, cache_control, weak in _CACHE_POLICIES:
        if pattern.match(path):
            return cache_control, weak
    return None


def _etag_header(digest: str, weak: bool) -> str:
    """Render a quoted ETag, weak (``W/"…"``) or strong (``"…"``)."""
    return f'W/"{digest}"' if weak else f'"{digest}"'


def _etag_digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


class ETagCacheMiddleware(BaseHTTPMiddleware):
    """Add ETag + Cache-Control to the endpoints listed in ``_CACHE_POLICIES``.

    Conditional GETs (``If-None-Match``) answered with 304 keep the ETag and
    all other caching headers; a mismatching validator produces a regular
    200 carrying the fresh ETag. Only GET requests are considered — HEAD
    would otherwise fingerprint an empty body as the ETag.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # The full stack below must always run: 304s still count against the
        # rate limiter, get logged, and carry X-Request-ID etc.
        response = await call_next(request)

        if request.method != "GET" or response.status_code != 200:
            return response

        policy = _match_policy(request.url.path)
        if policy is None:
            return response

        cache_control, weak = policy
        # The inner response arrives as a streaming wrapper; consume it so
        # the ETag can hash the real body, then rebuild a plain Response
        # (headers such as Content-Type are preserved).
        body = b"".join([chunk async for chunk in response.body_iterator])
        etag = _etag_header(_etag_digest(body), weak)

        # Vary keeps the per-user policies honest across caches. Only add it
        # where the response varies by user (auth-dependent endpoints).
        vary = request.url.path.startswith(("/v1/statistics/", "/v1/documents/"))

        if request.headers.get("if-none-match") == etag:
            headers = {"ETag": etag, "Cache-Control": cache_control}
            if vary:
                headers["Vary"] = "Authorization"
            return Response(
                status_code=304,
                headers=headers,
                background=response.background,
            )

        headers = dict(response.headers)
        headers["ETag"] = etag
        headers["Cache-Control"] = cache_control
        if vary:
            headers["Vary"] = "Authorization"
        return Response(
            content=body,
            status_code=response.status_code,
            headers=headers,
            background=response.background,
        )