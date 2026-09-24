"""Startup environment validation tests.

The application deliberately refuses to boot with missing security
configuration (no baked-in secrets), so the gate must be exercised
directly.
"""

import importlib

import pytest


def test_validate_environment_requires_secret_key(monkeypatch):
    from app.main import _validate_environment

    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _validate_environment()


def test_validate_environment_accepts_complete_configuration(monkeypatch):
    from app.main import _validate_environment

    monkeypatch.setenv("SECRET_KEY", "configured-secret-key")
    _validate_environment()  # must not raise


def test_database_requires_postgres_password(monkeypatch):
    """db.py must fail loudly instead of defaulting to a placeholder."""
    import app.database.db as db_module  # ensure the module is loaded first

    monkeypatch.delenv("POSTGRES_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="POSTGRES_PASSWORD"):
        importlib.reload(db_module)

    # The failed reload must not have corrupted the loaded module: with
    # the environment restored, the existing engine/session factories
    # remain intact and importable.
    from app.database.db import SessionLocal  # noqa: F401