import uuid
from datetime import UTC, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.database.db import Base


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    # Mirrors the ivfflat index created via raw SQL in migration 002, so
    # autogenerate and create_all stay in sync with the database. The GIN entry
    # does the same for the keyword-search index from migration 007: without it
    # in the model, the next `alembic revision --autogenerate` would read the
    # undeclared index as drift and try to drop the index that keyword search
    # depends on. Postgres only uses an expression index when the query repeats
    # the expression exactly, so this string must stay identical to the one in
    # the migration and to `app.repositories.search.full_text_vector`.
    __table_args__ = (
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

    embedding = mapped_column(Vector(1536), nullable=True)

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
