"""Tests for structured JSON logging (app.logging_config)."""

import json
import logging

from app.logging_config import JsonLogFormatter, setup_logging


def _record(name="app.access", msg="Request completed", level=logging.INFO, **extra):
    record = logging.LogRecord(name, level, __file__, 1, msg, None, None)
    for key, value in extra.items():
        setattr(record, key, value)
    return record


class TestJsonLogFormatter:
    def test_emits_parseable_json_with_core_fields(self):
        line = JsonLogFormatter().format(_record())
        payload = json.loads(line)
        assert payload["level"] == "INFO"
        assert payload["logger"] == "app.access"
        assert payload["message"] == "Request completed"
        assert isinstance(payload["ts"], float)

    def test_emits_access_extras_including_request_id(self):
        line = JsonLogFormatter().format(
            _record(
                request_id="rid-1",
                method="GET",
                path="/v1/health",
                status_code=200,
                process_time=0.0123,
                client_host="127.0.0.1",
            )
        )
        payload = json.loads(line)
        assert payload["request_id"] == "rid-1"
        assert payload["method"] == "GET"
        assert payload["path"] == "/v1/health"
        assert payload["status_code"] == 200
        assert payload["process_time"] == 0.0123
        assert payload["client_host"] == "127.0.0.1"

    def test_omits_absent_extras(self):
        payload = json.loads(JsonLogFormatter().format(_record()))
        assert "request_id" not in payload
        assert "method" not in payload

    def test_includes_exception_text_when_present(self):
        import sys

        try:
            raise ValueError("boom")
        except ValueError:
            record = logging.LogRecord(
                "app.services.x", logging.ERROR, __file__, 1, "failed", None, None
            )
            record.exc_info = sys.exc_info()
            record.exc_text = None
        line = JsonLogFormatter().format(record)
        payload = json.loads(line)
        assert "ValueError: boom" in payload["exception"]


class TestSetupLogging:
    def _restore(self, monkeypatch, original_handlers, original_level):
        monkeypatch.delenv("LOG_FORMAT", raising=False)
        root = logging.getLogger()
        root.handlers[:] = original_handlers
        root.setLevel(original_level)

    def test_json_installs_handler_when_env_set(self, monkeypatch):
        root = logging.getLogger()
        original_handlers = list(root.handlers)
        original_level = root.level
        try:
            monkeypatch.setenv("LOG_FORMAT", "json")
            setup_logging()
            json_handlers = [
                h
                for h in root.handlers
                if isinstance(h.formatter, JsonLogFormatter)
            ]
            assert json_handlers, "expected a JSON handler on root"
            assert root.level <= logging.INFO
        finally:
            self._restore(monkeypatch, original_handlers, original_level)

    def test_idempotent_when_called_twice(self, monkeypatch):
        root = logging.getLogger()
        original_handlers = list(root.handlers)
        original_level = root.level
        try:
            monkeypatch.setenv("LOG_FORMAT", "json")
            setup_logging()
            setup_logging()
            json_handlers = [
                h for h in root.handlers if isinstance(h.formatter, JsonLogFormatter)
            ]
            assert len(json_handlers) == 1
        finally:
            self._restore(monkeypatch, original_handlers, original_level)

    def test_unset_env_leaves_logging_untouched(self, monkeypatch):
        root = logging.getLogger()
        original_handlers = list(root.handlers)
        original_level = root.level
        try:
            monkeypatch.delenv("LOG_FORMAT", raising=False)
            setup_logging()
            assert root.handlers == original_handlers
            assert root.level == original_level
        finally:
            self._restore(monkeypatch, original_handlers, original_level)

    def test_plain_env_leaves_logging_untouched(self, monkeypatch):
        root = logging.getLogger()
        original_handlers = list(root.handlers)
        original_level = root.level
        try:
            monkeypatch.setenv("LOG_FORMAT", "plain")
            setup_logging()
            assert root.handlers == original_handlers
            assert root.level == original_level
        finally:
            self._restore(monkeypatch, original_handlers, original_level)