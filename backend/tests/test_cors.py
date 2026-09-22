"""Tests for the CORS configuration (env-driven origins, restricted scope).

The middleware wiring is read from the live FastAPI app; ``app.main`` is
reloaded with patched environment variables and restored afterwards.
"""

import importlib

DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5175",
    "http://localhost:3000",
]
_ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}
_ALLOWED_HEADERS = ["Content-Type", "Authorization", "Accept"]


def _cors_kwargs(main) -> dict:
    """Return the keyword arguments of the registered CORSMiddleware.

    Handles both the legacy ``(cls, kwargs)`` tuple form and the newer
    Starlette ``Middleware`` wrapper objects.
    """
    for middleware in main.app.user_middleware:
        if hasattr(middleware, "cls"):
            middleware_cls = middleware.cls
            kwargs = middleware.kwargs
        else:
            middleware_cls, kwargs = middleware[0], middleware[1]
        if middleware_cls.__name__ == "CORSMiddleware":
            return kwargs
    raise AssertionError("CORSMiddleware not registered on the app")


class TestParseCorsOrigins:
    def test_defaults_when_unset(self):
        from app.main import parse_cors_origins

        assert parse_cors_origins(None) == DEFAULT_ORIGINS

    def test_defaults_when_empty(self):
        from app.main import parse_cors_origins

        assert parse_cors_origins("") == DEFAULT_ORIGINS
        assert parse_cors_origins(" , ") == DEFAULT_ORIGINS

    def test_parses_comma_separated_list_with_whitespace(self):
        from app.main import parse_cors_origins

        assert parse_cors_origins("https://a.example, https://b.example ") == [
            "https://a.example",
            "https://b.example",
        ]

    def test_preserves_wildcard(self):
        from app.main import parse_cors_origins

        assert parse_cors_origins("*") == ["*"]

    def test_wildcard_dominates_mixed_list(self):
        """A stray "*" alongside explicit origins would otherwise allow
        all origins; explicit entries are dropped."""
        from app.main import parse_cors_origins

        assert parse_cors_origins("*,https://app.example.com") == ["*"]


class TestCorsMiddlewareWiring:
    def test_default_wiring_covers_dev_origins(self, monkeypatch):
        from app import main

        monkeypatch.delenv("CORS_ORIGINS", raising=False)
        importlib.reload(main)
        try:
            kwargs = _cors_kwargs(main)
            assert kwargs["allow_origins"] == DEFAULT_ORIGINS
            assert kwargs["allow_credentials"] is True
        finally:
            importlib.reload(main)

    def test_env_origins_and_restricted_scope(self, monkeypatch):
        from app import main

        monkeypatch.setenv(
            "CORS_ORIGINS", "https://app.example.com,https://admin.example.com"
        )
        importlib.reload(main)
        try:
            kwargs = _cors_kwargs(main)
            assert kwargs["allow_origins"] == [
                "https://app.example.com",
                "https://admin.example.com",
            ]
            assert kwargs["allow_credentials"] is True
            assert set(kwargs["allow_methods"]) == _ALLOWED_METHODS
            assert kwargs["allow_headers"] == _ALLOWED_HEADERS
        finally:
            monkeypatch.delenv("CORS_ORIGINS", raising=False)
            importlib.reload(main)

    def test_wildcard_disables_credentials(self, monkeypatch):
        """Starlette forbids credentials with a "*" wildcard origin."""
        from app import main

        monkeypatch.setenv("CORS_ORIGINS", "*")
        importlib.reload(main)
        try:
            kwargs = _cors_kwargs(main)
            assert kwargs["allow_origins"] == ["*"]
            assert kwargs["allow_credentials"] is False
        finally:
            monkeypatch.delenv("CORS_ORIGINS", raising=False)
            importlib.reload(main)