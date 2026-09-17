import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .middleware import LoggingMiddleware, RateLimitMiddleware
from .middleware.rate_limit import RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW
from .routes import auth, document, health, qa, search, statistics, users
from .schemas.error import ErrorDetail, ErrorResponse
from .storage.storage import storage

logger = logging.getLogger(__name__)

# Comma-separated list of allowed CORS origins. In production set
# CORS_ORIGINS to the real frontend origin(s), e.g. https://app.example.com.
_DEFAULT_CORS_ORIGINS = "http://localhost:5173,http://localhost:5175,http://localhost:3000"
CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", _DEFAULT_CORS_ORIGINS).split(",")
    if origin.strip()
]
if not CORS_ORIGINS:
    # An empty/misconfigured CORS_ORIGINS would silently break every
    # browser request; fail back to the dev defaults and warn instead.
    logger.warning(
        "CORS_ORIGINS resolved to no origins; falling back to %s",
        _DEFAULT_CORS_ORIGINS,
    )
    CORS_ORIGINS = _DEFAULT_CORS_ORIGINS.split(",")

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


def _error_code(status_code: int) -> str:
    return _EXCEPTION_CODES.get(
        status_code,
        "http_error",
    )


def _error_response(status_code: int, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(
            error=ErrorDetail(
                code=_error_code(status_code),
                message=message,
                details=details,
            )
        ).model_dump(),
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the MinIO bucket exists before serving any requests.
    try:
        storage.ensure_bucket()
        logger.info("MinIO bucket '%s' is ready", storage.bucket)
    except Exception as e:
        logger.warning("Could not ensure MinIO bucket on startup: %s", e)
    yield


app = FastAPI(
    title="AI Document Intelligence Platform",
    description="Upload, process, search, and ask questions about your documents",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Wrap every HTTPException in the standardized error envelope."""
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error=ErrorDetail(
                code=_error_code(exc.status_code),
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
    return _error_response(
        status_code=422,
        message="Request validation failed",
        details=details or None,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never leak internals: log the real error, return a generic 500."""
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return _error_response(
        status_code=500,
        message="An unexpected error occurred. Please try again.",
    )


app.add_middleware(LoggingMiddleware)
app.add_middleware(
    RateLimitMiddleware,
    requests=RATE_LIMIT_REQUESTS,
    window=RATE_LIMIT_WINDOW,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
    expose_headers=["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-Process-Time"],
)

app.include_router(auth.router, prefix="/v1")
app.include_router(document.router, prefix="/v1")
app.include_router(health.router, prefix="/v1")
app.include_router(search.router, prefix="/v1")
app.include_router(qa.router, prefix="/v1")
app.include_router(statistics.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")


@app.get("/")
def root():
    return {"msg": "backend live on!"}
