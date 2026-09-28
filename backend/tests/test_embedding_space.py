"""The storage-level contract for two embedding spaces.

These are the invariants the whole feature rests on, and they are all
things the *type system and the ORM cannot express*:

- one column per embedding space, because pgvector can only index one width;
- a row may not hold vectors from two spaces at once;
- a vector without a model is not searchable, which is what makes a
  pre-existing row safe rather than silently mis-ranked.

Each of these is asserted against the **real database**, not the model
declarations, because a constraint that exists only in the model is not a
constraint: the worker's ``bulk_save_objects`` path and any future writer both
bypass ORM-level validation, and only the database's own rules hold for every
one of them.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DataError, IntegrityError

from app.models.chunk import (
    LOCAL_EMBEDDING_SPACE,
    OPENAI_EMBEDDING_SPACE,
    DocumentChunk,
    embedding_column_for,
)
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB

OPENAI_MODEL = "text-embedding-ada-002"
LOCAL_MODEL = "nomic-embed-text"
OPENAI_WIDTH = 1536
LOCAL_WIDTH = 768


def _seed_document(db_session, marker: str = "space"):
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


def _vector(width: int) -> list[float]:
    return [0.1] * width


class TestSpaceToColumnMap:
    """`embedding_column_for` is the only space→column mapping.

    The worker writes through it and the search repository reads through it, so
    a second, divergent mapping is how a write goes to one column and a read
    from the other — which is invisible until every search comes back empty.
    """

    def test_the_openai_space_maps_to_the_indexed_column(self):
        assert embedding_column_for(OPENAI_EMBEDDING_SPACE) is DocumentChunk.embedding

    def test_the_local_space_maps_to_the_unconstrained_column(self):
        assert (
            embedding_column_for(LOCAL_EMBEDDING_SPACE) is DocumentChunk.embedding_local
        )

    def test_an_unknown_space_raises_instead_of_defaulting(self):
        """A typo must be loud at the point of use.

        Defaulting to some column would make the failure a silently empty
        search rather than an error someone can act on.
        """
        with pytest.raises(KeyError) as excinfo:
            embedding_column_for("huggingface")

        # The message has to say what was expected, so the fix is obvious.
        assert "unknown embedding space" in str(excinfo.value)
        assert "local" in str(excinfo.value)
        assert "openai" in str(excinfo.value)

    def test_every_space_has_a_column(self):
        """Neither space may be declared without storage.

        A space in `SPACE_CONFIGS` with no column would raise at write time,
        deep in the worker, instead of being caught here.
        """
        from app.services.embedding import SPACE_CONFIGS

        for space in SPACE_CONFIGS:
            assert embedding_column_for(space) is not None

    def test_no_two_spaces_share_a_column(self):
        columns = {
            embedding_column_for(OPENAI_EMBEDDING_SPACE),
            embedding_column_for(LOCAL_EMBEDDING_SPACE),
        }
        assert len(columns) == 2


class TestColumnWidths:
    """Why one column is width-typed and the other is not.

    pgvector measured refusals, not opinion: a distance query across a
    mixed-width column errors, a `::vector(n)` cast on a wrong-width row errors,
    and an ANN index on an unconstrained column cannot be created at all. So the
    OpenAI column stays `vector(1536)` — unchanged for every existing
    deployment — and the local one is unconstrained because the width of an
    Ollama embedding model is not ours to choose.
    """

    def test_the_openai_column_is_still_1536_wide(self):
        assert DocumentChunk.embedding.type.dim == 1536

    def test_the_local_column_is_unconstrained(self):
        assert DocumentChunk.embedding_local.type.dim is None

    def test_the_database_agrees_about_both_widths(self, db_session):
        rows = db_session.execute(
            text(
                """
                SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                WHERE c.relname = 'document_chunks'
                  AND a.attname IN ('embedding', 'embedding_local')
                """
            )
        ).all()
        types = dict(rows)

        assert types["embedding"] == "vector(1536)"
        assert types["embedding_local"] == "vector"

    def test_the_ivfflat_index_on_the_openai_column_survives(self, db_session):
        """The 'no change for an OpenAI deployment' claim, checked in the database.

        The local column deliberately gets no ANN index — an index cannot span
        widths, and a filtered scan of one user's chunks is not what the keyword
        fallback exists to be rescued from. So the invariant is that the
        *existing* index is still there and still on `embedding`.
        """
        rows = db_session.execute(
            text(
                """
                SELECT indexdef FROM pg_indexes
                WHERE tablename = 'document_chunks'
                  AND indexname = 'idx_document_chunks_embedding'
                """
            )
        ).all()

        assert len(rows) == 1, "the ivfflat index on `embedding` must still exist"
        definition = rows[0][0]
        assert "ivfflat" in definition
        assert "vector_cosine_ops" in definition
        assert "embedding" in definition


class TestSingleSpacePerRow:
    """A row may hold a vector from one space or the other, never both.

    Two vectors in one row makes every later search ambiguous — which column is
    authoritative, and which model produced each — and nothing in the query
    would reveal it, because both columns are non-null and either could be
    read. The constraint is in the database so it holds for every writer.
    """

    def test_the_check_constraint_is_in_the_database(self, db_session):
        rows = db_session.execute(
            text(
                """
                SELECT pg_get_constraintdef(oid) FROM pg_constraint
                WHERE conname = 'ck_document_chunks_single_embedding_space'
                """
            )
        ).all()

        assert len(rows) == 1, "the CHECK constraint must exist in the database"
        assert "embedding" in rows[0][0]
        assert "embedding_local" in rows[0][0]

    def test_a_row_with_vectors_from_both_spaces_is_rejected(self, db_session):
        """The database refuses it, not the ORM.

        The worker's bulk-insert path goes through `bulk_save_objects`, which
        does not validate field by field the way `add()` does, so only the
        database's own rule is dependable here.
        """
        doc = _seed_document(db_session, "both_spaces")
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="two spaces at once",
                chunk_index=0,
                embedding=_vector(OPENAI_WIDTH),
                embedding_local=_vector(LOCAL_WIDTH),
                embedding_model=OPENAI_MODEL,
            )
        )

        with pytest.raises(IntegrityError) as excinfo:
            db_session.commit()

        assert "ck_document_chunks_single_embedding_space" in str(excinfo.value)
        db_session.rollback()

    def test_either_space_alone_is_accepted(self, db_session):
        """The positive case for both sides, so the test above is not just
        'any vector is rejected'."""
        doc = _seed_document(db_session, "one_space")
        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id,
                    content="openai only",
                    chunk_index=0,
                    embedding=_vector(OPENAI_WIDTH),
                    embedding_model=OPENAI_MODEL,
                ),
                DocumentChunk(
                    document_id=doc.id,
                    content="local only",
                    chunk_index=1,
                    embedding_local=_vector(LOCAL_WIDTH),
                    embedding_model=LOCAL_MODEL,
                ),
                # And a row with no vector at all, which is the keyword-only
                # document: it must not be caught by the constraint.
                DocumentChunk(
                    document_id=doc.id,
                    content="no vector",
                    chunk_index=2,
                ),
            ]
        )
        db_session.commit()

        rows = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .all()
        )
        assert len(rows) == 3


class TestMixedWidthsInTheLocalColumn:
    """The local column holds any width, so something else has to stay correct.

    Two local models of different widths can share the column — the width check
    on the way out is what keeps a *new* wrong-width vector from being written.
    Existing rows can still disagree, which is why the search filters on the
    model and why a refused vector query has to degrade rather than 500.
    """

    def test_two_local_widths_coexist(self, db_session):
        doc = _seed_document(db_session, "mixed")
        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id,
                    content="768 wide",
                    chunk_index=0,
                    embedding_local=_vector(LOCAL_WIDTH),
                    embedding_model=LOCAL_MODEL,
                ),
                DocumentChunk(
                    document_id=doc.id,
                    content="384 wide",
                    chunk_index=1,
                    embedding_local=_vector(384),
                    embedding_model="all-minilm",
                ),
            ]
        )
        db_session.commit()

        rows = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .all()
        )
        # Both stored, neither rejected: the column is unconstrained on purpose.
        assert len(rows) == 2

    def test_a_wrong_width_in_the_typed_column_is_still_refused(self, db_session):
        """The OpenAI column keeps its type, so it still rejects a 768-wide row.

        This is the half of the design that protects every existing deployment:
        the local provider's vectors cannot end up in the indexed column, so
        they can never be ranked against 1536-wide ones.
        """
        doc = _seed_document(db_session, "wrong_width")
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="a 768-wide vector in a 1536 column",
                chunk_index=0,
                embedding=_vector(LOCAL_WIDTH),
                embedding_model=LOCAL_MODEL,
            )
        )

        # A DataError, not an IntegrityError: a width mismatch is a data
        # exception rather than a constraint violation, which is why the
        # assertion is on the class pgvector actually raises.
        with pytest.raises(DataError) as excinfo:
            db_session.commit()

        assert "expected 1536 dimensions, not 768" in str(excinfo.value)
        db_session.rollback()


class TestModelColumnIsRecorded:
    """`embedding_model` is what makes a vector findable *and* safe to rank."""

    def test_the_model_column_is_indexed(self, db_session):
        """Every vector search filters on it, so it earns its own index."""
        rows = db_session.execute(
            text(
                """
                SELECT indexname FROM pg_indexes
                WHERE tablename = 'document_chunks'
                  AND indexname = 'ix_document_chunks_embedding_model'
                """
            )
        ).all()

        assert len(rows) == 1

    def test_a_vector_may_be_written_without_a_model(self, db_session):
        """Allowed, and it is the pre-existing rows' state.

        Migration 008 leaves old vectors with a NULL model rather than guessing,
        so they are excluded from vector search and remain keyword-searchable —
        a visible state the operator can fix, instead of a wrong ranking.
        """
        doc = _seed_document(db_session, "no_model")
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="an older vector",
                chunk_index=0,
                embedding=_vector(OPENAI_WIDTH),
            )
        )
        db_session.commit()

        row = (
            db_session.query(DocumentChunk)
            .filter(DocumentChunk.document_id == doc.id)
            .one()
        )
        assert row.embedding_model is None
        assert row.embedding is not None
