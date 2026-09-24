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