import logging
import time
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("app.access")


class LoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        start_time = time.time()

        response = await call_next(request)

        process_time = time.time() - start_time
        status_code = response.status_code

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

        response.headers["X-Process-Time"] = str(round(process_time, 4))

        return response
