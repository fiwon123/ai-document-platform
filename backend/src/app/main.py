import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

# Registers the operational gauges (worker heartbeat, stale documents, Redis
# memory) that back the platform alerting rules.
from . import system_metrics  # noqa: F401
from .errors import register_exception_handlers
from .logging_config import setup_logging
from .middleware import LoggingMiddleware, RateLimitMiddleware
from .middleware.caching import ETagCacheMiddleware
from .middleware.rate_limit import RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW
from .routes import auth, document, health, qa, search, statistics, users, webhook
from .storage.storage import storage

logger = logging.getLogger(__name__)

# Structured JSON logging for production (Loki/Promtail); no-op unless
# LOG_FORMAT=json is set. Must run before any app logger emits.
setup_logging()

# Development defaults; override with the CORS_ORIGINS env var in
# production (comma-separated, e.g. "https://app.example.com,https://admin.example.com").
_DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5175",
    "http://localhost:3000",
]

_CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
_CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "Accept"]


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


# Tag descriptions enrich the OpenAPI docs (Swagger UI groups endpoints by
# router tag and shows these blurbs under each heading).
_OPENAPI_TAGS = [
    {
        "name": "auth",
        "description": "Register, log in, refresh the session, and manage your profile identity.",
    },
    {
        "name": "documents",
        "description": "Upload, inspect, preview, download, reprocess, and delete documents.",
    },
    {
        "name": "users",
        "description": "Self-service account management; admin-only user administration.",
    },
    {
        "name": "search",
        "description": "Semantic search over documents with pagination, filtering, and export.",
    },
    {
        "name": "qa",
        "description": "Ask questions about your documents and list available answering models.",
    },
    {
        "name": "statistics",
        "description": "Dashboard summaries for the user, or system-wide aggregates for admins.",
    },
    {
        "name": "webhooks",
        "description": "Subscribe to document events with signed, retried deliveries.",
    },
    {
        "name": "health",
        "description": "Liveness/readiness checks for the API and its infrastructure dependencies.",
    },
]

app = FastAPI(
    title="AI Document Intelligence Platform",
    description="Upload, process, search, and ask questions about your documents",
    version="1.0.0",
    lifespan=lifespan,
    contact={
        "name": "AI Document Intelligence Platform",
        "url": "https://github.com/fiwon123/ai-document-platform",
    },
    # A relative server URL keeps the docs valid on any origin: the dev
    # sandbox (localhost:8001) and the production ingress alike.
    servers=[{"url": "/", "description": "Served from the current origin"}],
    openapi_tags=_OPENAPI_TAGS,
)

register_exception_handlers(app)


app.add_middleware(LoggingMiddleware)
app.add_middleware(
    RateLimitMiddleware,
    requests=RATE_LIMIT_REQUESTS,
    window=RATE_LIMIT_WINDOW,
)
# ETag/Cache-Control for the select endpoints in middleware/caching.py.
# Registered inside CORS so 304 responses still carry CORS headers, and
# outside the app so request logging + rate limiting still see every hit.
app.add_middleware(ETagCacheMiddleware)
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
    """Welcome endpoint for the API root (the API itself lives under /v1)."""
    return {"msg": "backend live on!"}


@app.get("/metrics", include_in_schema=False)
def metrics() -> Response:
    """Prometheus text exposition of process + HTTP metrics.

    Scraped by the ServiceMonitor in the monitoring stack (see
    infra/k8s/overlays/production/monitoring.yaml); intentionally not part
    of the /v1 API schema.
    """
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
