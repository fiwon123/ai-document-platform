"""Startup environment validation tests.

The application deliberately refuses to boot with missing security
configuration (no baked-in secrets), so the gate must be exercised
directly.

Also covers published signing keys: a key that is *present* but committed to
this repository is a vulnerability rather than a missing value, and one of them
was found deployed to staging (#524).
"""

import importlib

import pytest

from app.config import (
    ALLOW_PLACEHOLDER_ENV_VAR,
    PUBLISHED_SECRET_KEYS,
    ensure_secret_key_acceptable,
)


def test_validate_environment_requires_secret_key(monkeypatch):
    # Imported before the patch on purpose: app.main imports the auth routes,
    # which validate SECRET_KEY at import time too.
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

    # DATABASE_URL goes too, and that is the point of the change (#664):
    # a complete URL carries the credential, so the password is no longer the
    # only thing that can supply one. Deleting only POSTGRES_PASSWORD left the
    # guard correctly unreached — the module was configured — so this test was
    # asserting the absence of a failure rather than the presence of the error.
    # The guard's real precondition is "no credentials from either source".
    monkeypatch.delenv("POSTGRES_PASSWORD", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="POSTGRES_PASSWORD"):
        importlib.reload(db_module)

    # The failed reload must not have corrupted the loaded module: with
    # the environment restored, the existing engine/session factories
    # remain intact and importable.
    from app.database.db import SessionLocal  # noqa: F401


class TestPublishedSigningKey:
    """A signing key committed to the repository is public, so the app must not
    boot with any of them. Every published value is checked, not just the first
    one that was reported: the Helm chart ships a second, different one."""

    @pytest.mark.parametrize("published", PUBLISHED_SECRET_KEYS)
    def test_refuses_a_published_key(self, published):
        with pytest.raises(RuntimeError, match="value committed to this repository"):
            ensure_secret_key_acceptable(published)

    @pytest.mark.parametrize("published", PUBLISHED_SECRET_KEYS)
    def test_the_error_names_the_offending_key(self, published):
        """Operators need to know which one they picked up."""
        with pytest.raises(RuntimeError, match=published):
            ensure_secret_key_acceptable(published)

    def test_both_known_published_keys_are_covered(self):
        """Pins the list itself, so a new published key cannot be added to a
        config file and quietly escape the guard."""
        assert PUBLISHED_SECRET_KEYS == (
            "your-secret-key-change-in-production",
            "change-me-jwt-secret",
        )

    def test_refuses_an_empty_key(self):
        with pytest.raises(RuntimeError, match="must be set"):
            ensure_secret_key_acceptable("")

    @pytest.mark.parametrize("truthy", ["1", "true", "TRUE", "yes", "on"])
    @pytest.mark.parametrize("published", PUBLISHED_SECRET_KEYS)
    def test_explicit_acknowledgement_allows_it(self, monkeypatch, truthy, published):
        """Local dev opts in explicitly, so the bypass is greppable."""
        monkeypatch.setenv(ALLOW_PLACEHOLDER_ENV_VAR, truthy)
        ensure_secret_key_acceptable(published)  # must not raise

    @pytest.mark.parametrize("falsy", ["", "0", "false", "no", "off", "maybe"])
    def test_anything_short_of_truthy_still_refuses(self, monkeypatch, falsy):
        monkeypatch.setenv(ALLOW_PLACEHOLDER_ENV_VAR, falsy)
        with pytest.raises(RuntimeError, match="value committed to this repository"):
            ensure_secret_key_acceptable(PUBLISHED_SECRET_KEYS[0])

    @pytest.mark.parametrize("real", ["a-real-random-key", "change-me-jwt-secret-2"])
    def test_a_real_key_is_accepted(self, real):
        ensure_secret_key_acceptable(real)  # must not raise

    @pytest.mark.parametrize("published", PUBLISHED_SECRET_KEYS)
    def test_startup_gate_refuses_a_published_key(self, monkeypatch, published):
        """The lifespan gate, not just the helper, is what an operator hits."""
        from app.main import _validate_environment  # imported before patching

        monkeypatch.setenv("SECRET_KEY", published)
        monkeypatch.delenv(ALLOW_PLACEHOLDER_ENV_VAR, raising=False)
        with pytest.raises(RuntimeError, match="value committed to this repository"):
            _validate_environment()

    def test_startup_gate_accepts_a_real_key(self, monkeypatch):
        from app.main import _validate_environment

        monkeypatch.setenv("SECRET_KEY", "a-real-random-key")
        _validate_environment()  # must not raise

    @pytest.mark.parametrize("published", PUBLISHED_SECRET_KEYS)
    def test_auth_module_refuses_a_published_key_at_import(self, monkeypatch, published):
        """auth.py signs every token, so it guards on import too — importing it
        must not be a way around the check that main.py applies at startup."""
        import app.routes.auth as auth_module  # ensure it is loaded first

        monkeypatch.setenv("SECRET_KEY", published)
        monkeypatch.delenv(ALLOW_PLACEHOLDER_ENV_VAR, raising=False)
        with pytest.raises(RuntimeError, match="value committed to this repository"):
            importlib.reload(auth_module)

        # Restore a usable module so the reload failure cannot poison the rest
        # of the session.
        monkeypatch.setenv("SECRET_KEY", "test-only-secret-key")
        importlib.reload(auth_module)
        assert auth_module.SECRET_KEY == "test-only-secret-key"
