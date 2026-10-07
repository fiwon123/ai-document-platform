"""Structured (JSON) logging setup for the backend.

The access logger and the request-id correlation (``middleware/
logging_context.py``) attach structured fields to log records, but the
default Python formatter drops them. With ``LOG_FORMAT=json`` this module
installs a formatter that emits one parseable JSON line per record, so
Loki/Promtail can index fields such as ``request_id``, ``method``,
``path``, ``status_code`` and ``process_time``.

When ``LOG_FORMAT`` is unset or ``plain`` the logging configuration is
left completely untouched (tests rely on this), and ``setup_logging()``
must be idempotent so module reloads never stack handlers.
"""

import json
import logging
import os

_LOG_FORMAT_ENV = "LOG_FORMAT"

# Fields the access middleware and code paths attach via ``extra``.
_EXTRA_FIELDS = (
    "request_id",
    "method",
    "path",
    "status_code",
    "process_time",
    "client_host",
)


class JsonLogFormatter(logging.Formatter):
    """Format a record as a single JSON object::

    {"ts": 1720000000.123, "level": "INFO", "logger": "app.access",
     "message": "Request completed", "request_id": "abc", ...}
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": round(record.created, 3),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for field in _EXTRA_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _logger_level() -> int:
    """Root level so ``app.access`` INFO lines are actually emitted."""
    return logging.INFO


def _has_json_handler(root: logging.Logger) -> bool:
    return any(
        isinstance(h, logging.StreamHandler) and isinstance(h.formatter, JsonLogFormatter)
        for h in root.handlers
    )


def setup_logging() -> None:
    """Install the JSON formatter when ``LOG_FORMAT=json`` is set.

    No-op otherwise (keeps default behavior and test tooling like caplog
    intact). Idempotent: never adds a second JSON handler to root.
    """
    if os.getenv(_LOG_FORMAT_ENV, "").strip().lower() != "json":
        return

    root = logging.getLogger()
    if _has_json_handler(root):
        return

    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    root.handlers[:] = [handler]
    root.setLevel(_logger_level())
