import logging
import re
import time
from collections.abc import Callable

from fastapi import Request, Response
from prometheus_client import Counter, Histogram
from starlette.middleware.base import BaseHTTPMiddleware

from app.middleware.logging_context import (
    install_request_id_stamping,
    reset_request_id,
    run_with_request_id,
)

logger = logging.getLogger("app.access")

# Stamp request ids on every log record (workers/startup fall back to '-').
install_request_id_stamping()

# Prometheus metrics exposed on the /metrics endpoint (scraped by the
# ServiceMonitor in the monitoring stack; see
# infra/k8s/overlays/production/monitoring.yaml).
HTTP_REQUESTS_TOTAL = Counter(
    "http_requests_total",
    "Total HTTP requests by method, path and status code",
    ["method", "path", "status"],
)
HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency by method and path",
    ["method", "path"],
)

# Collapse variable path segments (UUIDs, numeric ids) into a fixed label so
# the metrics cardinality stays bounded:
#   /v1/documents/<uuid>  -> /v1/documents/{id}
_PATH_PARAM_RE = re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|/\d+")


def _metric_path(path: str) -> str:
    return _PATH_PARAM_RE.sub("/{id}", path)


class LoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        start_time = time.time()

        request_id, ctx_token = run_with_request_id(request.headers.get("x-request-id"))
        try:
            response = await call_next(request)

            process_time = time.time() - start_time
            status_code = response.status_code

            # Instrumenting the scrape endpoint itself would just add noise.
            if request.url.path != "/metrics":
                metric_path = _metric_path(request.url.path)
                HTTP_REQUESTS_TOTAL.labels(request.method, metric_path, str(status_code)).inc()
                HTTP_REQUEST_DURATION_SECONDS.labels(request.method, metric_path).observe(
                    process_time
                )

            log_data = {
                "method": request.method,
                "path": request.url.path,
                "status_code": status_code,
                "process_time": round(process_time, 4),
                "client_host": request.client.host if request.client else "unknown",
            }

            if status_code >= 500:
                logger.error("Request failed", extra=log_data)
            elif status_code >= 400:
                logger.warning("Client error", extra=log_data)
            else:
                logger.info("Request completed", extra=log_data)

            response.headers["X-Request-ID"] = request_id
            response.headers["X-Process-Time"] = str(round(process_time, 4))

            return response
        finally:
            reset_request_id(ctx_token)