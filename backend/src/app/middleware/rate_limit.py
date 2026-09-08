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

_RATE_LIMIT_429_MESSAGE = "Too many requests. Please try again later."


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
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()

        if _redis_is_available():
            count = self._redis_count(client_ip)
            remaining = max(0, self.requests - count)
            if count > self.requests:
                return self._too_many_response()
        else:
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