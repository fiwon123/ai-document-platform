import ipaddress
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
# When Redis fails mid-request we stop probing for this long and fall
# back to the in-memory limiter, so a stalled Redis cannot take down the
# API or hammer the connection pool.
_REDIS_COOLDOWN_SECONDS = 30
_REDIS_DOWN_UNTIL: float = 0.0

# Upper bound for the in-memory fallback map. Prevents unbounded growth
# when Redis is down for a long time; the oldest entries are evicted once
# the limit is reached.
_MEMORY_FALLBACK_MAX_ENTRIES = 10_000

_RATE_LIMIT_429_MESSAGE = "Too many requests. Please try again later."

# Header set by trusted reverse proxies; the client IP is the first
# entry. It is only honored when the direct peer is in TRUSTED_PROXIES,
# otherwise a client could spoof it to rotate rate-limit buckets.
_FORWARDED_FOR_HEADER = "X-Forwarded-For"

# Comma-separated CIDRs (e.g. "10.0.0.0/8,172.16.0.0/12") whose requests
# may carry X-Forwarded-For. Empty (default) = never trust the header,
# so the limiter keys on the direct connection address.
_TRUSTED_PROXIES_ENV = "TRUSTED_PROXIES"


def _parse_trusted_proxies(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return networks


TRUSTED_PROXIES = _parse_trusted_proxies(os.getenv(_TRUSTED_PROXIES_ENV, ""))


def _redis_is_available() -> bool:
    """Whether Redis is reachable. Cached after the first probe; a failed
    mid-request call arms a cooldown so we stop hammering a down Redis."""
    global _REDIS_AVAILABLE, _REDIS_DOWN_UNTIL
    if time.time() < _REDIS_DOWN_UNTIL:
        return False
    if _REDIS_AVAILABLE is None:
        try:
            _REDIS_AVAILABLE = redis_client.ping()
        except Exception:  # noqa: BLE001 - probe failures just mean fallback
            _REDIS_AVAILABLE = False
    return _REDIS_AVAILABLE


def _mark_redis_unavailable() -> None:
    """Enter the cooldown: use the in-memory limiter for a while."""
    global _REDIS_AVAILABLE, _REDIS_DOWN_UNTIL
    _REDIS_AVAILABLE = False
    _REDIS_DOWN_UNTIL = time.time() + _REDIS_COOLDOWN_SECONDS


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

    def _trusted_proxy(self, direct_ip: str) -> bool:
        """Whether the direct peer is a configured trusted proxy."""
        if not TRUSTED_PROXIES or direct_ip == "unknown":
            return False
        try:
            addr = ipaddress.ip_address(direct_ip)
        except ValueError:
            return False
        return any(addr in net for net in TRUSTED_PROXIES)

    def _client_ip(self, request: Request) -> str:
        """Best-effort client IP.

        Only when the direct peer is a trusted proxy do we use the first
        valid entry of ``X-Forwarded-For`` (set by that proxy); otherwise
        a client could spoof the header to rotate rate-limit buckets.
        Falls back to the direct connection address in all other cases.
        """
        direct = request.client.host if request.client else "unknown"
        forwarded = request.headers.get(_FORWARDED_FOR_HEADER)
        if forwarded and self._trusted_proxy(direct):
            for candidate in forwarded.split(","):
                candidate = candidate.strip()
                if len(candidate) > 64:  # safety cap against absurd headers
                    continue
                try:
                    ipaddress.ip_address(candidate)
                except ValueError:
                    continue
                return candidate
        return direct

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

    def _memory_count(self, client_ip: str, now: float) -> int | None:
        """Slide the in-memory window; return remaining or None if over."""
        if (
            client_ip not in self.clients
            and len(self.clients) >= _MEMORY_FALLBACK_MAX_ENTRIES
            and self.clients
        ):
            # Evict the oldest visitor (dicts preserve insertion order).
            self.clients.pop(next(iter(self.clients)))

        self.clients[client_ip] = [
            t for t in self.clients[client_ip] if now - t < self.window
        ]

        if len(self.clients[client_ip]) >= self.requests:
            return None

        self.clients[client_ip].append(now)
        return max(0, self.requests - len(self.clients[client_ip]))

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
            try:
                count = self._redis_count(client_ip)
                remaining = max(0, self.requests - count)
                if count > self.requests:
                    return self._too_many_response()
            except Exception:  # noqa: BLE001 - degrade to the in-memory limiter
                _mark_redis_unavailable()
                remaining = self._memory_count(client_ip, now)
                if remaining is None:
                    return self._too_many_response()
        else:
            remaining = self._memory_count(client_ip, now)
            if remaining is None:
                return self._too_many_response()

        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.requests)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response