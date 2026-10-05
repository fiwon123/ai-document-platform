"""Re-embedding the rows migration 008 left unsearchable.

The tool exists to undo a deliberate, documented decision: 008 made
pre-existing rows invisible to vector search rather than guess which model had
written their vectors. The risk is therefore not that it does nothing, but that
it does the *guess* anyway — so most of what is asserted here is about what it
refuses to do:

- it recomputes from ``content`` and never relabels an existing vector;
- it is idempotent, so a second run cannot quietly attribute old vectors to a
  new model;
- it does not write a row that holds the other space's vector, which the
  database forbids;
- it reports rows it could not fix instead of counting them as success.

All of it runs against the **real database** (``conftest``), because the
interesting constraints are the schema's and pgvector's, not the ORM's.
"""

import pytest

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.services.embedding import EmbeddingDimensionMismatch
from app.services.embedding_backfill import (
    SKIP_NO_TEXT,
    SKIP_OTHER_SPACE,
    plan_backfill,
    require_active_space,
    run_backfill,
)

OPENAI_MODEL = "text-embedding-ada-002"
OPENAI_WIDTH = 1536
LOCAL_WIDTH = 768


class FakeService:
    """An embedding service that writes a recognisable vector.

    A stub rather than a mock of the module under test, because the thing worth
    checking is which rows end up labelled and with what — not that a method was
    called.
    """

    def __init__(self, space="openai", model=OPENAI_MODEL, width=OPENAI_WIDTH):
        self.space = space
        self.model = model
        self.width = width
        self.calls: list[list[str]] = []
        self.fail_with: Exception | None = None

    def generate_embeddings(self, texts):
        self.calls.append(list(texts))
        if self.fail_with is not None:
            raise self.fail_with
        return [[0.5] * self.width for _ in texts]


class FlakyService(FakeService):
    """Fails the first ``fail_calls`` provider calls, then behaves normally.

    Stands in for a transient provider error: the point is that one bad batch
    must not end a run over thousands of rows, so the failure has to be
    per-call rather than per-run.
    """

    def __init__(self, fail_calls=1, **kwargs):
        super().__init__(**kwargs)
        self.fail_calls = fail_calls

    def generate_embeddings(self, texts):
        if self.fail_calls > 0:
            self.fail_calls -= 1
            raise RuntimeError("provider 503")
        return super().generate_embeddings(texts)


def _seed(db_session, marker):
    user = UserDB(username=marker, hashed_password="x")  # noqa: S106
    db_session.add(user)
    db_session.flush()
    doc = DocumentDB(
        owner_id=user.id,
        filename=f"{marker}.txt",
        object_key=f"k/{marker}.txt",
        mime_type="text/plain",
        status=DocumentStatus.READY,
    )
    db_session.add(doc)
    db_session.commit()
    return doc


def _chunk(db, doc, *, content="some searchable text", model=None, vector=None):
    chunk = DocumentChunk(
        document_id=doc.id,
        content=content,
        chunk_index=0,
        embedding_model=model,
    )
    if vector is not None:
        setattr(chunk, "embedding" if model != "local-ish" else "embedding_local", vector)
    db.add(chunk)
    db.commit()
    return chunk


class TestRequireActiveSpace:
    def test_refuses_when_no_provider_is_configured(self):
        """A misconfigured deployment must not look like a successful run."""
        service = FakeService(space=None, model=None)
        with pytest.raises(RuntimeError, match="No embedding provider"):
            require_active_space(service)

    def test_returns_the_space_and_model(self):
        assert require_active_space(FakeService()) == ("openai", OPENAI_MODEL)


class TestPlan:
    def test_counts_every_bucket_without_writing(self, db_session):
        doc = _seed(db_session, "plan")
        _chunk(db_session, doc)                                   # to embed
        _chunk(db_session, doc, content="   ")                    # no text
        _chunk(db_session, doc, model=OPENAI_MODEL, vector=[0.1] * OPENAI_WIDTH)

        plan = plan_backfill(db_session, service=FakeService())

        assert plan.to_embed == 1
        assert plan.no_text == 1
        assert plan.already_current == 1
        assert plan.other_space == 0
        # the whole point of a plan: nothing was written
        assert db_session.query(DocumentChunk).filter(
            DocumentChunk.embedding_model == OPENAI_MODEL
        ).count() == 1

    def test_counts_a_row_holding_the_other_space_as_blocked(self, db_session):
        """Not "to embed": the CHECK constraint makes it impossible."""
        doc = _seed(db_session, "blocked")
        chunk = _chunk(db_session, doc, content="text", model=None)
        chunk.embedding = [0.1] * OPENAI_WIDTH
        db_session.commit()

        local = FakeService(space="local", model="nomic-embed-text", width=LOCAL_WIDTH)
        plan = plan_backfill(db_session, service=local)

        assert plan.other_space == 1
        assert plan.to_embed == 0


class TestRunBackfill:
    def test_recomputes_and_labels_unlabelled_rows(self, db_session):
        doc = _seed(db_session, "unlabelled")
        chunk = _chunk(db_session, doc, content="the words to embed")

        result = run_backfill(db_session, service=FakeService())

        db_session.refresh(chunk)
        assert result.embedded == 1
        assert chunk.embedding_model == OPENAI_MODEL
        assert chunk.embedding is not None
        assert len(chunk.embedding) == OPENAI_WIDTH

    def test_is_idempotent(self, db_session):
        """A second run must be a no-op, not a relabel.

        This is the regression that matters: if a run attributed an old vector
        to a newly configured model, cosine distance would return confident,
        wrong rankings — the exact failure 008 refused to allow.
        """
        doc = _seed(db_session, "idempotent")
        chunk = _chunk(db_session, doc, content="stable text")
        service = FakeService()

        run_backfill(db_session, service=service)
        calls_after_first = len(service.calls)
        second = run_backfill(db_session, service=service)

        db_session.refresh(chunk)
        assert second.embedded == 0
        assert len(service.calls) == calls_after_first
        assert chunk.embedding_model == OPENAI_MODEL

    def test_recomputes_a_vector_whose_label_is_stale(self, db_session):
        """A vector from another model is replaced, not relabelled.

        Recomputing is what makes the new label honest; copying the label across
        is the guess.
        """
        doc = _seed(db_session, "stale")
        chunk = _chunk(db_session, doc, content="fresh text")
        chunk.embedding = [0.9] * OPENAI_WIDTH
        chunk.embedding_model = "text-embedding-3-small"   # 1536-wide, different model
        db_session.commit()

        result = run_backfill(db_session, service=FakeService())

        db_session.refresh(chunk)
        assert result.embedded == 1
        assert chunk.embedding_model == OPENAI_MODEL
        assert chunk.embedding[0] == 0.5   # recomputed, not the 0.9 left behind

    def test_never_writes_a_row_holding_the_other_space(self, db_session):
        doc = _seed(db_session, "other")
        chunk = _chunk(db_session, doc, content="text")
        chunk.embedding = [0.1] * OPENAI_WIDTH
        db_session.commit()

        local = FakeService(space="local", model="nomic-embed-text", width=LOCAL_WIDTH)
        result = run_backfill(db_session, service=local)

        db_session.refresh(chunk)
        assert result.embedded == 0
        assert result.skipped[SKIP_OTHER_SPACE] == 1
        assert chunk.embedding is not None          # untouched
        assert chunk.embedding_local is None        # not written
        assert chunk.embedding_model is None        # and not guessed at

    def test_reports_empty_content_instead_of_writing_an_unlabelled_row(self, db_session):
        doc = _seed(db_session, "empty")
        chunk = _chunk(db_session, doc, content="   ")

        result = run_backfill(db_session, service=FakeService())

        db_session.refresh(chunk)
        assert result.embedded == 0
        assert result.skipped[SKIP_NO_TEXT] == 1
        assert chunk.embedding is None
        assert chunk.embedding_model is None

    def test_limit_bounds_the_work(self, db_session):
        doc = _seed(db_session, "limit")
        for _ in range(5):
            _chunk(db_session, doc, content="text")

        result = run_backfill(db_session, service=FakeService(), limit=2)

        assert result.embedded == 2
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model == OPENAI_MODEL)
            .count()
            == 2
        )

    def test_pages_past_a_corpus_larger_than_one_page(self, db_session, monkeypatch):
        """Pagination must not stop at PAGE_SIZE, and must not rescan.

        A page-sized corpus is the case that distinguishes keyset pagination
        from a loop that stops after the first page.
        """
        import app.services.embedding_backfill as backfill

        monkeypatch.setattr(backfill, "PAGE_SIZE", 3)
        doc = _seed(db_session, "paged")
        total = 7
        for _ in range(total):
            _chunk(db_session, doc, content="text")

        result = run_backfill(db_session, service=FakeService(), batch_size=2)

        # The claim is that pagination keeps going: 7 chunks with a page of 3
        # means the run must not stop after the first page. Batch count is not
        # asserted because batching is per-page by design, which makes the exact
        # number a function of two constants rather than a behaviour.
        assert result.embedded == total
        assert result.embedded > backfill.PAGE_SIZE
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model == OPENAI_MODEL)
            .count()
            == total
        )

    def test_a_failed_batch_costs_one_batch_not_the_run(self, db_session):
        """A transient provider failure must not abandon thousands of rows."""
        doc = _seed(db_session, "flaky")
        for _ in range(4):
            _chunk(db_session, doc, content="text")
        service = FlakyService(fail_calls=1)
        result = run_backfill(db_session, service=service, batch_size=2)

        assert result.embedded == 2      # second batch succeeded
        assert result.batches == 1

    def test_a_dimension_mismatch_stops_the_run(self, db_session):
        """A width mismatch is a config error; retrying it cannot help."""
        doc = _seed(db_session, "mismatch")
        for _ in range(4):
            _chunk(db_session, doc, content="text")
        service = FakeService()
        service.fail_with = EmbeddingDimensionMismatch("configured 768, provider returned 1536")

        with pytest.raises(EmbeddingDimensionMismatch):
            run_backfill(db_session, service=service, batch_size=2)

        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model == OPENAI_MODEL)
            .count()
            == 0
        )

    def test_a_short_response_skips_the_batch_rather_than_mispairing(self, db_session):
        """Pairing positionally would attach each vector to the wrong chunk."""
        doc = _seed(db_session, "short")
        chunk = _chunk(db_session, doc, content="text")
        _chunk(db_session, doc, content="other text")
        service = FakeService()
        service.generate_embeddings = lambda texts: [[0.5] * OPENAI_WIDTH]  # 1 for 2

        result = run_backfill(db_session, service=service, batch_size=2)

        db_session.refresh(chunk)
        assert result.embedded == 0
        # Neither row written: a shifted pairing would attach the one vector to
        # whichever chunk happened to be first.
        assert chunk.embedding is None
        assert chunk.embedding_model is None
        assert (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.embedding_model == OPENAI_MODEL)
            .count()
            == 0
        )


class TestAfterBackfillTheRowsAreFindable:
    """The end state has to be the thing the tool promises.

    Asserted through the real search query, because "the row is labelled and
    has a vector" and "the row is visible to semantic search" are different
    claims and only the second one is the point.
    """

    def test_a_backfilled_chunk_is_matched_by_the_search_query(self, db_session):
        from app.models.chunk import embedding_column_for
        from app.repositories.search import SearchRepository

        doc = _seed(db_session, "findable")
        _chunk(db_session, doc, content="the quick brown fox")

        # before: invisible, which is the whole reason this tool exists
        column = embedding_column_for("openai")
        assert (
            db_session.query(DocumentChunk.id)
            .filter(column.isnot(None), DocumentChunk.embedding_model == OPENAI_MODEL)
            .count()
            == 0
        )

        run_backfill(db_session, service=FakeService())

        outcome = SearchRepository(db_session).search(
            user_id=doc.owner_id,
            query_embedding=[0.5] * OPENAI_WIDTH,
            top_k=5,
            query_text="quick brown fox",
            query_space="openai",
            query_model=OPENAI_MODEL,
        )
        assert outcome.total_count == 1
        assert outcome.results[0].document_filename == "findable.txt"
