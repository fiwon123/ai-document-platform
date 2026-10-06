import uuid
from datetime import UTC, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.database.db import Base

# The two *embedding spaces* a chunk's vector can belong to. Named here, in the
# storage layer, because they are a statement about columns: the space decides
# which column holds the vector, and `embedding_column_for` below is the only
# mapping from one to the other.
#
# Why a space per column at all, given that one column could hold both
# providers' vectors: pgvector can only index vectors of a single width, which
# is not an assumption but three measured refusals against pgvector 0.8.6 —
#
#   CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops)  -- no width
#   ERROR:  column does not have dimensions
#   INSERT of a 3-wide value into a vector(5) column
#   ERROR:  different vector dimensions 3 and 5
#   SELECT ... ORDER BY a::vector(4) over a 3-wide row
#   ERROR:  expected 4 dimensions, not 3
#
# So a single unconstrained column could store both, but could not be indexed;
# and a single width-typed column would reject the other provider's vectors
# outright, which would break the search queries already working against
# `embedding` today. Two columns keep `embedding` (OpenAI, 1536) exactly as it
# was — still indexed, still a plain `vector(1536)`, no behaviour change for a
# deployment that has an OpenAI key — while the local provider writes to
# `embedding_local`, which is unconstrained because the width of an Ollama
# embedding model is not ours to choose.
#
# The local column has no ANN index. The `embedding_model` filter below is the
# index that matters for it, and a filtered scan of one user's chunks is not
# what the keyword fallback exists to be rescued from.
OPENAI_EMBEDDING_SPACE = "openai"
LOCAL_EMBEDDING_SPACE = "local"


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    __table_args__ = (
        # A chunk is embedded by one model, once, in one space. Letting a row
        # hold both would make every later search ambiguous — which column is
        # the one to trust, and which model produced it. Enforced here rather
        # than in the worker's insert path so the rule holds for every writer,
        # including a future one.
        CheckConstraint(
            "embedding IS NULL OR embedding_local IS NULL",
            name="ck_document_chunks_single_embedding_space",
        ),
        # Mirrors the ivfflat index created via raw SQL in migration 002, so
        # autogenerate and create_all stay in sync with the database. The GIN
        # entry does the same for the keyword-search index from migration 007:
        # without it in the model, the next
        # `alembic revision --autogenerate` would read the undeclared index as
        # drift and try to drop the index that keyword search depends on.
        # Postgres only uses an expression index when the query repeats the
        # expression exactly, so this string must stay identical to the one in
        # the migration and to `app.repositories.search.full_text_vector`.
        #
        # Only `embedding` is indexed. See the space constants above: an ANN
        # index cannot span widths, and the local column is deliberately
        # unconstrained.
        Index(
            "idx_document_chunks_embedding",
            "embedding",
            postgresql_using="ivfflat",
            postgresql_ops={"embedding": "vector_cosine_ops"},
            postgresql_with={"lists": 100},
        ),
        Index(
            "idx_document_chunks_content_fts",
            text("to_tsvector('english', content)"),
            postgresql_using="gin",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    content: Mapped[str] = mapped_column(Text, nullable=False)

    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)

    # The OpenAI space. Still 1536-wide and still the only indexed column, so
    # a deployment with an OpenAI key behaves exactly as it did before the
    # local provider existed.
    embedding = mapped_column(Vector(1536), nullable=True)

    # The local space. Unconstrained width on purpose: nomic-embed-text is
    # 768, mxbai-embed-large 1024, all-minilm 384, and the operator picks the
    # model. `embedding_model` on each row is what keeps that safe — see the
    # width check in `app.services.embedding`.
    embedding_local = mapped_column(Vector(), nullable=True)

    # Which model produced this row's vector, and therefore which space it
    # belongs to. Two different failure modes make this necessary rather than
    # decorative:
    #
    # 1. Same width, different model. text-embedding-ada-002 and
    #    text-embedding-3-small are both 1536-wide, so switching between them
    #    is invisible to a width check, to the column type, and to the database
    #    — and cosine distance between two unrelated embedding spaces is a
    #    real number, not an error. It would rank results confidently and
    #    wrongly. This column is the filter that prevents it.
    # 2. Different width, same space. Local models vary, and the column cannot
    #    reject the odd width, so a mixed-width column would make the *query*
    #    fail ("different vector dimensions") the moment a row of another width
    #    is compared. Filtering on this column is what keeps the unconstrained
    #    column safe to search.
    #
    # NULL for a chunk with no vector, and for vectors written before this
    # column existed — see migration 008 for what that means for them.
    embedding_model: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        index=True,
    )

    metadata_: Mapped[dict | None] = mapped_column(
        "metadata",
        JSONB,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )

    # passive_deletes: the FK is ON DELETE CASCADE at the DB level, so the
    # ORM must NOT try to null out the loaded chunk collection when the
    # parent is deleted (document_id is NOT NULL — the nullification would
    # raise NotNullViolation, and the DB cascade handles cleanup anyway).
    # The option must sit on the parent-side backref (chunks) too, because
    # that is the collection the unit of work consults on parent deletes.
    document = relationship(
        "DocumentDB",
        backref=backref("chunks", passive_deletes=True),
        passive_deletes=True,
    )


# The only mapping from a space to the column that holds it. The worker (which
# writes), the search repository (which reads) and the embedding service (which
# names the space) all go through here rather than writing `if space == ...`
# twice — the bug that shape invites is a write going to one column and a read
# from the other, which is invisible until every search comes back empty.
def embedding_column_for(space: str):
    """Return the column holding ``space``'s vectors.

    Raises ``KeyError`` for an unknown space rather than defaulting: a typo in
    a space name has to be loud at the point of use, not a silent
    always-empty search.
    """
    columns = {
        OPENAI_EMBEDDING_SPACE: DocumentChunk.embedding,
        LOCAL_EMBEDDING_SPACE: DocumentChunk.embedding_local,
    }
    try:
        return columns[space]
    except KeyError:
        raise KeyError(
            f"unknown embedding space {space!r}; expected one of {sorted(columns)}"
        ) from None
