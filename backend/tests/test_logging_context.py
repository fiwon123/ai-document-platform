"""Tests for request-id correlation (middleware + logging context)."""

import logging

from app.middleware.logging_context import (
    get_request_id,
    install_request_id_stamping,
    reset_request_id,
    run_with_request_id,
)


class TestLoggingMiddleware:
    def test_generates_and_echoes_request_id(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        request_id = resp.headers.get("x-request-id")
        assert request_id
        assert request_id != "-"
        assert len(request_id) <= 100

    def test_inbound_request_id_is_passed_through(self, client):
        resp = client.get("/", headers={"X-Request-ID": "abc-123"})
        assert resp.status_code == 200
        assert resp.headers.get("x-request-id") == "abc-123"

    def test_oversized_or_empty_header_is_normalized(self, client):
        resp = client.get("/", headers={"X-Request-ID": "x" * 500})
        assert resp.status_code == 200
        assert len(resp.headers.get("x-request-id")) <= 100

        resp = client.get("/", headers={"X-Request-ID": "   "})
        assert resp.status_code == 200
        request_id = resp.headers.get("x-request-id")
        assert request_id
        assert request_id != "   "

    def test_unique_ids_across_requests(self, client):
        first = client.get("/").headers.get("x-request-id")
        second = client.get("/").headers.get("x-request-id")
        assert first != second

    def test_access_log_record_carries_request_id(self, client, caplog):
        caplog.set_level(logging.INFO, logger="app.access")
        resp = client.get("/")
        header = resp.headers.get("x-request-id")
        assert header

        matching = [r for r in caplog.records if r.name == "app.access"]
        assert matching
        assert all(getattr(r, "request_id", None) == header for r in matching)


class TestLoggingContext:
    def test_default_outside_request(self):
        assert get_request_id() == "-"

    def test_set_and_reset(self):
        request_id, token = run_with_request_id("trace-42")
        try:
            assert get_request_id() == "trace-42"
        finally:
            reset_request_id(token)
        assert get_request_id() == "-"

    def test_generates_id_when_none_given(self):
        request_id, token = run_with_request_id(None)
        try:
            assert request_id
            assert request_id != "-"
            assert get_request_id() == request_id
        finally:
            reset_request_id(token)

    def test_nested_scopes_restore_outer(self):
        outer, outer_token = run_with_request_id("outer")
        try:
            inner, inner_token = run_with_request_id("inner")
            try:
                assert get_request_id() == "inner"
            finally:
                reset_request_id(inner_token)
            assert get_request_id() == "outer"
        finally:
            reset_request_id(outer_token)

    def test_stamping_installs_once(self):
        install_request_id_stamping()
        install_request_id_stamping()
        assert True  # idempotent, no exception

    def test_records_carry_default_id_outside_request(self, caplog):
        install_request_id_stamping()
        caplog.set_level(logging.INFO)
        logging.getLogger("app.reqid.test").info("hello from default scope")
        records = [r for r in caplog.records if r.name == "app.reqid.test"]
        assert records
        assert all(getattr(r, "request_id", None) == "-" for r in records)

    def test_records_carry_request_id_inside_scope(self, caplog):
        install_request_id_stamping()
        caplog.set_level(logging.INFO)
        request_id, token = run_with_request_id("inside-9")
        try:
            logging.getLogger("app.reqid.inside").info("hello from request")
        finally:
            reset_request_id(token)
        records = [r for r in caplog.records if r.name == "app.reqid.inside"]
        assert records
        assert all(getattr(r, "request_id", None) == "inside-9" for r in records)