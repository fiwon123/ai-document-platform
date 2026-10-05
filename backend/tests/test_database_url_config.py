"""``DATABASE_URL`` must be honoured when it is the only database config given (#664).

``app.database.db`` used to assemble the URL from ``POSTGRES_*`` and raise at
import time when ``POSTGRES_PASSWORD`` was missing, never looking at
``DATABASE_URL`` at all. The migrate Job supplies *only* ``DATABASE_URL``, so
``alembic upgrade head`` died with a ``RuntimeError`` about a password it had
never been asked for — in every environment, and on every run.

The awkward part is that ``migrations/env.py`` already preferred ``DATABASE_URL``
and had a correct fallback. Its logic was simply unreachable, because line 7 is
``from app.database import Base``, and that import raises before the branch runs.

These tests reload the module under a controlled environment rather than patching
``os.environ``, because the decision is made once at import time — patching
afterwards would test nothing.
"""

from __future__ import annotations

import contextlib
import importlib
import sys

import pytest

MODULE = "app.database.db"

#: Every variable the module consults, so a test env is genuinely clean rather
#: than merely missing the one key it cares about.
ALL_DB_ENV = (
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_HOST",
    "POSTGRES_PORT",
)


class _NoopGauge:
    """Stands in for the pool gauge so a reload cannot collide in the registry.

    ``db.py`` creates ``POOL_CHECKED_IN`` at import time. Importing the module a
    second time therefore registers the same metric twice, and Prometheus raises
    ``DuplicateTimeseries`` — which says nothing about the behaviour under test.
    Reachable collectors are also stateful, and re-registering them leaves each
    test holding a copy of the previous one's engine.
    """

    def __init__(self, *args, **kwargs) -> None:
        pass

    def labels(self, *args, **kwargs) -> _NoopGauge:
        return self

    def set(self, *args, **kwargs) -> None:
        pass

    def inc(self, *args, **kwargs) -> None:
        pass

    def dec(self, *args, **kwargs) -> None:
        pass

    def set_function(self, *args, **kwargs) -> None:
        pass


@pytest.fixture
def load_db(monkeypatch: pytest.MonkeyPatch):
    """Import a fresh copy of the module under a controlled environment.

    A no-op ``load_dotenv`` keeps a developer's or the sandbox's real ``.env``
    from leaking into the result — the committed ``backend/src/app/.env`` is
    gitignored but does exist locally.

    The original module object is put back afterwards, in *both* places a
    submodule can be found. Leaving it removed is worse than it sounds: every
    other test in the session holds the ``Base`` and ``SessionLocal`` that the
    application was imported with, so a later import would hand out a
    *different* pair and the failures cascade across the whole suite rather than
    pointing at this file.

    Restoring only ``sys.modules`` is not enough, and the residue is subtle
    enough to be worth spelling out. Re-importing rebinds the attribute on the
    parent package (``app.database.db``), so after the teardown the two
    disagree: ``sys.modules`` holds the original while the attribute holds the
    discarded copy. ``import app.database.db as x`` then binds the *attribute*,
    and a subsequent ``importlib.reload(x)`` raises
    ``ImportError: module app.database.db not in sys.modules`` — from a test
    that never touched this fixture. That is exactly how
    ``test_environment.py::test_database_requires_postgres_password`` failed.
    """
    import dotenv
    import prometheus_client

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)
    monkeypatch.setattr(prometheus_client, "Gauge", _NoopGauge)

    parent_name, _, attr = MODULE.rpartition(".")
    parent = sys.modules.get(parent_name)
    missing = object()
    original = sys.modules.get(MODULE, missing)
    original_attr = getattr(parent, attr, missing) if parent is not None else missing

    def _load(env: dict[str, str | None]):
        """Re-import the module with exactly ``env`` set (value ``None`` = unset).

        A mapping rather than keyword arguments on purpose: ``POSTGRES_PASSWORD=``
        as a keyword trips ruff's ``S106``, and widening the per-file ignore list
        for one argument name is a worse trade than passing a dict. ``conftest``
        sets the same variable through ``os.environ.setdefault`` for the same
        reason.
        """
        for name in ALL_DB_ENV:
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            if value is not None:
                monkeypatch.setenv(name, value)

        sys.modules.pop(MODULE, None)
        return importlib.import_module(MODULE)

    yield _load

    if original is missing:
        sys.modules.pop(MODULE, None)
    else:
        sys.modules[MODULE] = original
    if parent is not None:
        if original_attr is missing:
            with contextlib.suppress(AttributeError):
                delattr(parent, attr)
        else:
            setattr(parent, attr, original_attr)


def test_database_url_alone_is_enough(load_db) -> None:
    """The migrate Job's configuration: one variable, no POSTGRES_* at all."""
    url = "postgresql://postgres:s3cr3t@postgres:5432/mydb"

    module = load_db({"DATABASE_URL": url})

    assert module.SQLALCHEMY_DATABASE_URL == url


def test_database_url_wins_over_postgres_parts(load_db) -> None:
    """Two paths to one setting, so one has to take precedence.

    It matches ``migrations/env.py``, which has read ``DATABASE_URL`` first all
    along — and whose preference was previously unobservable, because this module
    raised first whenever the parts were incomplete.
    """
    module = load_db(
        {
            "DATABASE_URL": "postgresql://from:url@url-host:5432/url-db",
            "POSTGRES_USER": "from",
            "POSTGRES_PASSWORD": "parts",
            "POSTGRES_HOST": "parts-host",
            "POSTGRES_PORT": "6543",
            "POSTGRES_DB": "parts-db",
        }
    )

    assert module.SQLALCHEMY_DATABASE_URL == (
        "postgresql://from:url@url-host:5432/url-db"
    )


def test_postgres_parts_still_work_without_database_url(load_db) -> None:
    """The dev sandbox and any deployment that configures the parts directly."""
    module = load_db(
        {
            "POSTGRES_USER": "someone",
            "POSTGRES_PASSWORD": "parts",
            "POSTGRES_HOST": "db.internal",
            "POSTGRES_PORT": "6543",
            "POSTGRES_DB": "docs",
        }
    )

    assert module.SQLALCHEMY_DATABASE_URL == (
        "postgresql://someone:parts@db.internal:6543/docs"
    )


def test_postgres_parts_honour_their_defaults(load_db) -> None:
    """Only the password is mandatory; the rest keep their documented defaults."""
    module = load_db({"POSTGRES_PASSWORD": "parts"})

    assert module.SQLALCHEMY_DATABASE_URL == (
        "postgresql://postgres:parts@localhost:5432/mydb"
    )


def test_missing_everything_still_fails_fast(load_db) -> None:
    """The guard the original code was written for is not weakened.

    No URL and no password is the case where a placeholder would have been
    silently used, so it must still raise rather than connect somewhere
    unexpected.
    """
    with pytest.raises(RuntimeError) as excinfo:
        load_db({})

    message = str(excinfo.value)
    assert "DATABASE_URL" in message, "the error must name both ways to fix it"
    assert "POSTGRES_PASSWORD" in message


def test_empty_database_url_falls_back_to_the_parts(load_db) -> None:
    """An empty string is "not configured", not "connect to ''".

    ``os.getenv`` returns ``""`` for a variable set to nothing, which the compose
    file does pass for some settings. Treating that as a usable URL would produce
    an engine pointed at no host at all.
    """
    module = load_db({"DATABASE_URL": "", "POSTGRES_PASSWORD": "parts", "POSTGRES_HOST": "db"})

    assert module.SQLALCHEMY_DATABASE_URL == "postgresql://postgres:parts@db:5432/mydb"


def test_engine_is_built_from_the_resolved_url(load_db) -> None:
    """The URL is not just exported correctly — the engine has to use it."""
    module = load_db({"DATABASE_URL": "postgresql://postgres:pw@db.example:5432/app"})

    engine = module.engine

    assert engine.url.host == "db.example"
    assert engine.url.database == "app"
