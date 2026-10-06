"""Request-scoped logging context (request-id correlation).

The request id is set by LoggingMiddleware for the duration of a request
and exposed to any code running inside it (services, repos). A global log
record factory stamps ``record.request_id`` onto every log record so
structured formatters (JSON, Loki) can group lines of one request together.

A root-level logging.Filter would NOT work here: ancestor logger filters
are never consulted for records emitted by child loggers, so records from
``app.*`` loggers would never be stamped.
"""

import contextvars
import logging
from uuid import uuid4

_REQUEST_ID_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id",
    default="-",
)

# Roughly the longest sane header value; longer trace ids get truncated so
# log lines stay readable.
MAX_REQUEST_ID_LENGTH = 100

_ORIGINAL_RECORD_FACTORY: logging.LogRecordFactory | None = None


def get_request_id() -> str:
    """Return the id of the current request, or '-' outside a request."""
    return _REQUEST_ID_CTX.get()


def reset_request_id(token: object) -> None:
    """Leave a request-id scope entered with run_with_request_id."""
    _REQUEST_ID_CTX.reset(token)


def run_with_request_id(request_id: str | None) -> tuple[str, object]:
    """Enter a request-id scope.

    Returns ``(request_id, token)``; prefer using the middleware, this is
    for tests and background tasks that want explicit correlation.
    """
    normalized = _normalize_request_id(request_id) or uuid4().hex
    token = _REQUEST_ID_CTX.set(normalized)
    return normalized, token


def _normalize_request_id(raw: str | None) -> str | None:
    """Sanitize an inbound id: strip, drop empty, cap length and control
    characters so it cannot be used to bloat or break log lines."""
    if not raw:
        return None
    cleaned = "".join(ch for ch in raw.strip() if ch.isprintable())
    if not cleaned:
        return None
    return cleaned[:MAX_REQUEST_ID_LENGTH]


def install_request_id_stamping() -> None:
    """Wrap the log-record factory so every record carries ``request_id``.

    Idempotent: safe to call from module import and from tests.
    """
    global _ORIGINAL_RECORD_FACTORY
    if _ORIGINAL_RECORD_FACTORY is not None:
        return

    original = logging.getLogRecordFactory()
    _ORIGINAL_RECORD_FACTORY = original

    def _factory(*args, **kwargs) -> logging.LogRecord:
        record = original(*args, **kwargs)
        record.request_id = get_request_id()
        return record

    logging.setLogRecordFactory(_factory)
