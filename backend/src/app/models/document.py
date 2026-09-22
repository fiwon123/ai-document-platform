import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import Boolean, DateTime, Enum, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database.db import Base


class DocumentStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class DocumentDB(Base):
    __tablename__ = "documents"

    # Mirrors migration 004: per-user document listing queries on
    # WHERE owner_id = ? ORDER BY created_at DESC, which PostgreSQL serves
    # with a backward scan of this composite index (the owner_id index
    # alone would need a sort of every row of the user).
    __table_args__ = (
        Index(
            "ix_documents_owner_id_created_at",
            "owner_id",
            "created_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
        index=True,
    )

    filename: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    object_key: Mapped[str] = mapped_column(
        String(500),
        nullable=False,
        unique=True,
    )

    mime_type: Mapped[str | None] = mapped_column(
        String(100),
        nullable=True,
    )

    status: Mapped[DocumentStatus] = mapped_column(
        # Persist the enum *values* (e.g. "pending", "processing") rather than
        # the member names (e.g. "PENDING"), so they match the PostgreSQL enum
        # type created by the migration (values 'pending','processing',...).
        Enum(DocumentStatus, values_callable=lambda e: [m.value for m in e]),
        default=DocumentStatus.PENDING,
        nullable=False,
    )

    error_message: Mapped[str | None] = mapped_column(
        String,
        nullable=True,
    )

    # True once the worker rendered a visual thumbnail (PDFs only) and
    # stored it next to the original in object storage.
    has_thumbnail: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )
