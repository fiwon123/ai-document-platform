"""The backfill CLI: flags, exit codes, and what a dry run promises.

The service behind it is tested in ``test_embedding_backfill.py``. What is
tested here is the wrapper, because that is where a flag can be accepted, shown
in ``--help`` and then quietly ignored — which is exactly what ``--limit`` did
in a dry run until this file existed.
"""

import importlib.util
from pathlib import Path

import pytest

from app.models.chunk import DocumentChunk
from app.services.embedding_backfill import plan_backfill

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backfill_embeddings.py"


def _load_cli(monkeypatch, service):
    """Import the script by path (it is not a package) with a stub service."""
    spec = importlib.util.spec_from_file_location("backfill_cli", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "EmbeddingService", lambda: service)
    monkeypatch.setattr(module, "SessionLocal", lambda: _session())
    return module


def _session():
    from app.database.db import SessionLocal

    return SessionLocal()


class StubService:
    def __init__(self, space="openai", model="text-embedding-ada-002", width=1536):
        self.space = space
        self.model = model
        self.width = width

    def generate_embeddings(self, texts):
        return [[0.5] * self.width for _ in texts]


@pytest.fixture()
def seeded(db_session, monkeypatch):
    from app.models.document import DocumentDB, DocumentStatus
    from app.models.user import UserDB

    user = UserDB(username="cli", hashed_password="x")  # noqa: S106
    db_session.add(user)
    db_session.flush()
    doc = DocumentDB(
        owner_id=user.id,
        filename="cli.txt",
        object_key="k/cli.txt",
        mime_type="text/plain",
        status=DocumentStatus.READY,
    )
    db_session.add(doc)
    db_session.commit()
    for _ in range(3):
        db_session.add(
            DocumentChunk(document_id=doc.id, content="text", chunk_index=0)
        )
    db_session.commit()
    return doc


class TestDryRun:
    def test_writes_nothing_without_apply(self, db_session, seeded, monkeypatch, capsys):
        """The default must be safe: a run that costs money is opt-in."""
        cli = _load_cli(monkeypatch, StubService())
        assert cli.main([]) == 0

        out = capsys.readouterr().out
        assert "no writes" in out
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model.isnot(None))
            .count()
            == 0
        )

    def test_limit_is_reported_rather_than_silently_ignored(
        self, seeded, monkeypatch, capsys
    ):
        """A flag that bounds the write must say so in a dry run too.

        `--limit` used to be accepted, documented as bounding the run, and
        dropped on the floor here — the plan printed the full corpus either way,
        with nothing to indicate the flag had been discarded.
        """
        cli = _load_cli(monkeypatch, StubService())
        cli.main(["--limit", "2"])

        out = capsys.readouterr().out
        assert "would examine at most 2 chunk(s)" in out

    def test_reports_the_plan(self, seeded, monkeypatch, capsys):
        cli = _load_cli(monkeypatch, StubService())
        cli.main([])
        out = capsys.readouterr().out
        assert "3 to re-embed" in out
        assert "text-embedding-ada-002" in out


class TestApply:
    def test_writes_when_asked(self, db_session, seeded, monkeypatch, capsys):
        cli = _load_cli(monkeypatch, StubService())
        assert cli.main(["--apply"]) == 0

        out = capsys.readouterr().out
        assert "embedded 3 chunk(s)" in out
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model == "text-embedding-ada-002")
            .count()
            == 3
        )

    def test_limit_bounds_a_write_run(self, db_session, seeded, monkeypatch, capsys):
        cli = _load_cli(monkeypatch, StubService())
        cli.main(["--apply", "--limit", "1"])
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model.isnot(None))
            .count()
            == 1
        )

    def test_nothing_to_do_is_not_an_error(self, seeded, monkeypatch, capsys):
        """A second run has no work and must not look like a failure."""
        cli = _load_cli(monkeypatch, StubService())
        cli.main(["--apply"])
        capsys.readouterr()

        assert cli.main(["--apply"]) == 0
        assert "nothing to do" in capsys.readouterr().out


class TestRefusals:
    def test_exits_2_with_a_message_when_no_provider(self, seeded, monkeypatch, capsys):
        """Exit 2 and one sentence, not a traceback: it is a config fix."""
        cli = _load_cli(monkeypatch, StubService(space=None, model=None))
        assert cli.main([]) == 2

        err = capsys.readouterr().err
        assert "No embedding provider" in err
        assert "Traceback" not in err

    def test_warns_that_the_local_run_is_not_the_whole_job(
        self, seeded, monkeypatch, capsys
    ):
        """One space per run, said out loud rather than implied by silence."""
        cli = _load_cli(
            monkeypatch, StubService(space="local", model="nomic-embed-text", width=768)
        )
        cli.main([])
        out = capsys.readouterr().out
        assert "local space only" in out
        assert "run again" in out


class TestPlanAgreesWithTheCLI:
    def test_the_cli_does_not_report_different_numbers(self, seeded, monkeypatch, capsys):
        """The plan the CLI prints is the one the service computes.

        A CLI that recomputed its own counts could drift from the thing that
        does the work, and the number an operator budgets against is the number
        on screen.
        """
        cli = _load_cli(monkeypatch, StubService())
        cli.main([])
        printed = capsys.readouterr().out

        from app.database.db import SessionLocal

        with SessionLocal() as db:
            plan = plan_backfill(db, service=StubService())
        assert plan.summary() in printed
