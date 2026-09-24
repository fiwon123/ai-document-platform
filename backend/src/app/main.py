import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .errors import register_exception_handlers
from .logging_config import setup_logging
from .middleware import LoggingMiddleware, RateLimitMiddleware
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

register_exception_handlers(app)


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
