import os
import time
from collections import defaultdict
from collections.abc import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.cache.redis import redis_client

RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "100"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))

# Only trust proxy-provided headers when explicitly enabled. Off by default:
# an untrusted client must never be able to rotate X-Forwarded-For and
# bypass the limiter. Enable in production behind a proxy that overwrites
# X-Forwarded-For (e.g. k8s ingress, nginx proxy_set_header).
TRUST_PROXY_HEADERS = (
    os.getenv("TRUST_PROXY_HEADERS", "").strip().lower() in {"1", "true", "yes", "on"}
)

# Upper bound on distinct client buckets held by the in-memory fallback so
# an unreachable Redis can never grow the process memory without limit.
MAX_IN_MEMORY_CLIENTS = 10_000

# Anything longer than this is junk, not an IP. Bounds the size of derived
# rate-limit keys even when proxy headers are trusted.
_MAX_FORWARDED_TOKEN_LENGTH = 64

# Probed once per process; None = not yet probed.
_REDIS_AVAILABLE: bool | None = None

_RATE_LIMIT_429_MESSAGE = "Too many requests. Please try again later."


def _client_ip(request: Request) -> str:
    """Best-effort client IP.

    When ``TRUST_PROXY_HEADERS`` is enabled the socket peer is the proxy
    itself, so the real client is the leftmost entry of ``X-Forwarded-For``
    (proxies append, never prepend). Falls back to the socket peer when the
    header is absent, empty, or implausibly long.
    """
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            client = forwarded.split(",")[0].strip()
            if client and len(client) <= _MAX_FORWARDED_TOKEN_LENGTH:
                return client
    return request.client.host if request.client else "unknown"


def _redis_is_available() -> bool:
    """Whether Redis is reachable. Cached after the first probe."""
    global _REDIS_AVAILABLE
    if _REDIS_AVAILABLE is None:
        _REDIS_AVAILABLE = redis_client.ping()
    return _REDIS_AVAILABLE


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiter per client IP.

    Uses Redis (fixed window with TTL via atomic INCR) when available so
    limits hold across multiple app instances. Falls back to an
    in-process sliding window when Redis is unreachable (local dev
    without Redis, automated tests).

    Why per-IP, and what that means (#489)
    --------------------------------------
    This limiter guards *this application*, and it is deliberately keyed by IP
    rather than by user. Three reasons, and the cost of each:

    - **It runs before authentication.** A per-user key would mean parsing a
      JWT in the middleware for every request, including anonymous ones, and
      deciding what to do with requests that carry no user at all.
    - **It must bound a single hostile client.** One IP generating a flood is
      the case a limiter exists for, and IP is the only identifier available
      before a credential is presented.
    - **Its cost is shared-NAT unfairness.** Several users behind one corporate
      gateway, NAT, or the container bridge consume a single bucket, so one user
      can exhaust the allowance of everyone else on that network. This is
      accepted, not overlooked: the ceiling it protects is the app's own, and
      the alternative lets a single client behind rotating IPs consume the
      service unthrottled.

    This limiter is NOT what bounds LLM provider usage, and lowering it to
    satisfy a provider's quota would be the wrong lever — it throttles document
    listing, search and login to pay for one endpoint's upstream budget. The
    per-provider request and token budgets live in
    ``app.services.provider_quota`` instead, keyed by provider and org-wide
    because that is the granularity the provider enforces.

    ``TRUST_PROXY_HEADERS`` assumption: when enabled, the socket peer is a proxy
    the operator controls, which **overwrites** ``X-Forwarded-For`` rather than
    appending to client-supplied values. Behind nginx or a k8s ingress that
    holds (``proxy_set_header X-Forwarded-For $remote_addr``). In front of a
    proxy that merely passes the header through, enabling this lets any client
    mint a fresh identity per request and bypass the limiter entirely — so it
    stays off by default and is a deployment decision, not a default.
    """

    def __init__(self, app, requests: int = 100, window: int = 60):
        super().__init__(app)
        self.requests = requests
        self.window = window
        self.clients: dict[str, list[float]] = defaultdict(list)

    def _redis_count(self, client_ip: str) -> int:
        """Atomic INCR, key expires ``window`` seconds after first hit."""
        key = f"ratelimit:{client_ip}"
        count = redis_client.increment(key)
        if count == 1:
            redis_client.client.expire(key, self.window)
        return count

    def _too_many_response(self) -> JSONResponse:
        """429 in the standardized error envelope.

        Returning a response directly (instead of raising HTTPException)
        is required: exceptions raised from middleware dispatch bypass
        FastAPI's exception handlers and would surface as 500s.
        """
        return JSONResponse(
            status_code=429,
            # Mirrors the standardized schemas.error.ErrorResponse envelope
            # ({error: {code, message, details}}) without importing it, so
            # this module stays independent of the error-envelope change.
            content={
                "error": {
                    "code": "rate_limit_exceeded",
                    "message": _RATE_LIMIT_429_MESSAGE,
                    "details": None,
                }
            },
            headers={
                "X-RateLimit-Limit": str(self.requests),
                "X-RateLimit-Remaining": "0",
                "Retry-After": str(self.window),
            },
        )

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        client_ip = _client_ip(request)
        now = time.time()

        if _redis_is_available():
            count = self._redis_count(client_ip)
            remaining = max(0, self.requests - count)
            if count > self.requests:
                return self._too_many_response()
        else:
            # Bound the fallback: evict the oldest bucket before inserting a
            # new one (dicts preserve insertion order).
            if client_ip not in self.clients and len(self.clients) >= MAX_IN_MEMORY_CLIENTS:
                self.clients.pop(next(iter(self.clients)))

            history = [
                t for t in self.clients.get(client_ip, []) if now - t < self.window
            ]

            if len(history) >= self.requests:
                return self._too_many_response()

            history.append(now)
            self.clients[client_ip] = history
            remaining = max(0, self.requests - len(history))

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.requests)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response