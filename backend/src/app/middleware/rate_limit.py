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

# Probed once per process; None = not yet probed.
_REDIS_AVAILABLE: bool | None = None

# Upper bound for the in-memory fallback map. Prevents unbounded growth
# when Redis is down for a long time; the oldest entries are evicted once
# the limit is reached.
_MEMORY_FALLBACK_MAX_ENTRIES = 10_000

_RATE_LIMIT_429_MESSAGE = "Too many requests. Please try again later."

# Header(s) set by trusted reverse proxies; the client IP is the first entry.
_FORWARDED_FOR_HEADER = "X-Forwarded-For"


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
    """

    def __init__(self, app, requests: int = 100, window: int = 60):
        super().__init__(app)
        self.requests = requests
        self.window = window
        self.clients: dict[str, list[float]] = defaultdict(list)

    def _client_ip(self, request: Request) -> str:
        """Best-effort client IP.

        Uses the first ``X-Forwarded-For`` entry when present (set by the
        reverse proxy in front of the app), falling back to the direct
        connection address.
        """
        forwarded = request.headers.get(_FORWARDED_FOR_HEADER)
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _redis_count(self, client_ip: str) -> int:
        """Atomic fixed-window counter.

        INCR + EXPIRE run inside a single Redis MULTI/EXEC transaction so
        the key can never be left without a TTL (expiry is set with
        ``nx=True``, only on the first request).
        """
        return redis_client.increment_with_ttl(
            f"ratelimit:{client_ip}",
            ttl=self.window,
        )

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
        client_ip = self._client_ip(request)
        now = time.time()

        if _redis_is_available():
            count = self._redis_count(client_ip)
            remaining = max(0, self.requests - count)
            if count > self.requests:
                return self._too_many_response()
        else:
            # Evict the oldest non-memory visitors once the map grows too
            # large so a Redis outage cannot leak memory indefinitely.
            if client_ip not in self.clients and len(self.clients) >= _MEMORY_FALLBACK_MAX_ENTRIES:
                self.clients.pop(next(iter(self.clients)))

            self.clients[client_ip] = [
                t for t in self.clients[client_ip] if now - t < self.window
            ]

            if len(self.clients[client_ip]) >= self.requests:
                return self._too_many_response()

            self.clients[client_ip].append(now)
            remaining = max(0, self.requests - len(self.clients[client_ip]))

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.requests)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response