"""Standardized error infrastructure for the API.

Owns the error envelope: stable machine-readable codes, the JSONResponse
builder, and the FastAPI exception handlers. Kept out of ``main.py`` so
the app entrypoint only does wiring and error policy can be unit-tested
in isolation (see ``tests/test_error_handling.py``).
"""

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .schemas.error import ErrorDetail, ErrorResponse
from .services.provider_quota import ProviderRateLimited

logger = logging.getLogger(__name__)

# Stable machine-readable codes for common HTTP statuses.
_EXCEPTION_CODES: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    413: "content_too_large",
    422: "validation_error",
    429: "rate_limit_exceeded",
    500: "internal_error",
    503: "service_unavailable",
}

# A provider that ran out of quota is NOT the app's own rate limit hitting, and
# the two call for different responses: the app limiter is a client that should
# back off, a provider ceiling is a server whose upstream allowance is gone.
# Both are 429, but they carry different codes so a caller — and anyone reading
# the logs — can tell "you sent too much" from "we are out of provider quota".
PROVIDER_RATE_LIMITED_CODE = "provider_rate_limited"


def error_code(status_code: int) -> str:
    return _EXCEPTION_CODES.get(status_code, "http_error")


def error_response(status_code: int, message: str, details: dict | None = None) -> JSONResponse:
    """Build a JSONResponse in the canonical error envelope:
    ``{"error": {"code": ..., "message": ..., "details": ...}}``.
    """
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(
            error=ErrorDetail(
                code=error_code(status_code),
                message=message,
                details=details,
            )
        ).model_dump(),
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Attach the envelope-emitting exception handlers to the app."""

    @app.exception_handler(ProviderRateLimited)
    async def provider_rate_limited_handler(
        request: Request, exc: ProviderRateLimited
    ) -> JSONResponse:
        """A provider ceiling stopped the call — report it as a real 429.

        Previously this reached the client as a 200 whose body said the
        provider could not be reached, which is why an exhausted free tier was
        indistinguishable from a misconfigured one. ``Retry-After`` is passed
        through so a client can back off for as long as the provider (or our
        own counter) says, rather than guessing.

        ``details`` carries the provider, which ceiling, the limit, the
        ``source`` and, when the provider reported one, its own message — enough
        for an operator to act without exposing anything account-specific.
        """
        message = (
            f"The {exc.provider} provider is rate limited. "
            f"Please retry in {exc.retry_after} seconds."
        )
        return JSONResponse(
            status_code=429,
            content=ErrorResponse(
                error=ErrorDetail(
                    code=PROVIDER_RATE_LIMITED_CODE,
                    message=message,
                    details={
                        "provider": exc.provider,
                        "scope": exc.scope or None,
                        "limit": exc.limit,
                        "used": exc.used,
                        "source": exc.source,
                        "retry_after": exc.retry_after,
                        "detail": exc.detail or None,
                    },
                )
            ).model_dump(),
            headers={
                "Retry-After": str(exc.retry_after),
                "X-Provider": exc.provider,
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
        """Wrap every HTTPException in the standardized error envelope."""
        return JSONResponse(
            status_code=exc.status_code,
            content=ErrorResponse(
                error=ErrorDetail(
                    code=error_code(exc.status_code),
                    message=str(exc.detail),
                )
            ).model_dump(),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Return request validation errors with field-level details."""
        details: dict = {}
        for error in exc.errors():
            loc = ".".join(str(part) for part in error.get("loc", []) if part != "body")
            details[loc or "body"] = error.get("msg", "invalid")
        return error_response(
            status_code=422,
            message="Request validation failed",
            details=details or None,
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        """Never leak internals: log the real error, return a generic 500."""
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return error_response(
            status_code=500,
            message="An unexpected error occurred. Please try again.",
        )