import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .middleware import LoggingMiddleware, RateLimitMiddleware
from .middleware.rate_limit import RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW
from .routes import auth, document, health, qa, search, statistics, users, webhook
from .schemas.error import ErrorDetail, ErrorResponse
from .storage.storage import storage

logger = logging.getLogger(__name__)

# Development defaults; override with the CORS_ORIGINS env var in
# production (comma-separated, e.g. "https://app.example.com,https://admin.example.com").
_DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5175",
    "http://localhost:3000",
]

_CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
_CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "Accept"]

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


def parse_cors_origins(raw: str | None) -> list[str]:
    """Parse the CORS_ORIGINS env var (comma-separated origins).

    Returns the development defaults when unset or empty. A literal "*"
    is preserved so Starlette's wildcard handling applies; mixing a
    wildcard with explicit origins would silently allow all origins
    (Starlette treats any list containing "*" as allow-all), so any
    explicit entries are dropped when a wildcard is present.
    """
    if raw:
        origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
        if origins:
            if "*" in origins:
                return ["*"]
            return origins
    return list(_DEFAULT_CORS_ORIGINS)


def _validate_environment() -> None:
    """Fail fast on startup when required security configuration is missing.

    Security-sensitive settings must never ship baked-in defaults; a
    missing value is a misconfiguration, so refuse to boot rather than
    run in a broken (or unexpectedly permissive) state.
    """
    missing = []
    if not os.getenv("SECRET_KEY"):
        missing.append("SECRET_KEY (JWT signing key)")
    if missing:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(missing)
        )

    if os.getenv("MINIO_ACCESS_KEY", "minioadmin") == "minioadmin" or os.getenv(
        "MINIO_SECRET_KEY", "minioadmin"
    ) == "minioadmin":
        logger.warning(
            "MinIO is using the default admin credentials — override "
            "MINIO_ACCESS_KEY/MINIO_SECRET_KEY in non-local environments"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Refuse to serve with an invalid/missing security configuration.
    _validate_environment()

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
_cors_origins = parse_cors_origins(os.getenv("CORS_ORIGINS"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    # Starlette forbids allow_credentials=True together with a "*" wildcard;
    # browsers never send stored credentials to a fully-wildcard origin anyway.
    allow_credentials="*" not in _cors_origins,
    allow_methods=_CORS_ALLOWED_METHODS,
    allow_headers=_CORS_ALLOWED_HEADERS,
)

app.include_router(auth.router, prefix="/v1")
app.include_router(document.router, prefix="/v1")
app.include_router(health.router, prefix="/v1")
app.include_router(search.router, prefix="/v1")
app.include_router(qa.router, prefix="/v1")
app.include_router(statistics.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(webhook.router, prefix="/v1")


@app.get("/")
def root():
    return {"msg": "backend live on!"}


@app.get("/metrics", include_in_schema=False)
def metrics() -> Response:
    """Prometheus text exposition of process + HTTP metrics.

    Scraped by the ServiceMonitor in the monitoring stack (see
    infra/k8s/overlays/production/monitoring.yaml); intentionally not part
    of the /v1 API schema.
    """
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
