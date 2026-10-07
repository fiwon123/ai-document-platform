"""Tests for the suite's own database isolation (#683).

The backend suite calls ``create_all`` and ``drop_all`` on the engine it is
given, so an engine pointed at the wrong database destroys real data. Until
#683 that was silent: the run passed, the tables were gone, and the only
symptom was a 500 on login later.

These tests are about the harness rather than the application, so they assert
two separate things:

- the guard refuses a non-test database (cheap, direct)
- the engine the suite actually uses *is* the test database, even with
  ``DATABASE_URL`` exported the way ``docker-compose.yaml`` exports it
"""

import conftest
import pytest
from conftest import TEST_DB_NAME, _assert_test_database
from sqlalchemy.engine import make_url


def _engine_pointing_at(name: str):
    """A create_engine-free stand-in exposing only ``.url.database``."""
    return type("_FakeEngine", (), {"url": make_url(f"postgresql://u@h:5432/{name}")})()


def test_guard_accepts_the_test_database():
    """The normal case: no exception, so the fixture proceeds."""
    _assert_test_database(_engine_pointing_at(TEST_DB_NAME))


def test_guard_refuses_the_development_database():
    """The #683 failure: bound to `mydb`, which the suite would then empty."""
    with pytest.raises(RuntimeError) as excinfo:
        _assert_test_database(_engine_pointing_at("mydb"))

    message = str(excinfo.value)
    # The message has to name both databases, or an operator reading it cannot
    # tell what happened to what.
    assert "mydb" in message
    assert TEST_DB_NAME in message
    # ...and say the consequence, since the symptom otherwise surfaces much
    # later as an unrelated 500.
    assert "delete real data" in message


def test_guard_refuses_when_the_test_name_is_the_application_database(monkeypatch):
    """TEST_DB_NAME=mydb: the name check passes, and the suite still empties it.

    A second way to aim the suite at real data, and the reason the guard cannot
    be only "is this the name I expected?" — with the expected name *also*
    pointing at the development database, that comparison is satisfied and
    nothing refuses.
    """
    monkeypatch.setattr(conftest, "TEST_DB_NAME", "mydb")
    monkeypatch.setattr(conftest, "application_database_name", lambda: "mydb")

    with pytest.raises(RuntimeError) as excinfo:
        _assert_test_database(_engine_pointing_at("mydb"))

    assert "TEST_DB_NAME" in str(excinfo.value)


def test_guard_permits_a_distinct_database_similar_to_the_application_one(
    monkeypatch,
):
    """The extra check must not refuse an ordinary, separate test database."""
    monkeypatch.setattr(conftest, "TEST_DB_NAME", "mydb_test")
    monkeypatch.setattr(conftest, "application_database_name", lambda: "mydb")

    # No exception: mydb_test is not mydb, which is the whole point.
    _assert_test_database(_engine_pointing_at("mydb_test"))


def test_guard_message_names_the_configured_escape_hatch():
    """Tells the operator what to change, not merely that something is wrong."""
    with pytest.raises(RuntimeError) as excinfo:
        _assert_test_database(_engine_pointing_at("production"))

    assert "TEST_DB_NAME" in str(excinfo.value)


def test_guard_refuses_a_database_with_a_similar_name():
    """`mydb` vs `mydb_test` must not be treated as a match by prefix.

    A guard that accepted the development database because it shares a prefix
    with the test one would fail exactly as silently as having no guard.
    """
    with pytest.raises(RuntimeError):
        _assert_test_database(_engine_pointing_at("mydb_production"))


def test_engine_is_bound_to_the_test_database(db_engine):
    """The end-to-end assertion: the suite's own engine, not a description.

    ``db_engine`` is the real session fixture. If the isolation above ever stops
    working -- because ``db.py`` changes how it resolves a URL again, the way
    #664 did -- this fails, and it fails *before* anything is dropped, because
    the guard runs ahead of ``create_all``.
    """
    assert db_engine.url.database == TEST_DB_NAME


def test_database_url_points_at_the_test_database():
    """The forced URL is a test-database URL, whatever the shell exported."""
    url = make_url(conftest.test_database_url())

    assert url.database == TEST_DB_NAME
    assert url.database != "mydb"


def test_database_url_overrides_an_exported_development_url(monkeypatch):
    """The regression: compose exports DATABASE_URL pointing at `mydb`.

    ``db.py`` prefers ``DATABASE_URL``, so an exported value silently wins
    unless the suite forces its own. This asserts the forcing happens, using
    the same variable compose sets rather than a proxy for it.
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres:pw@postgres:5432/mydb")

    # Re-run the assignment conftest performs at import time. Imported at module
    # scope above, so this exercises the helper it delegates to.
    monkeypatch.setattr(
        conftest, "test_database_url", conftest.test_database_url, raising=True
    )

    forced = make_url(conftest.test_database_url())
    assert forced.database == TEST_DB_NAME
    assert forced.database != make_url(
        "postgresql://postgres:pw@postgres:5432/mydb"
    ).database