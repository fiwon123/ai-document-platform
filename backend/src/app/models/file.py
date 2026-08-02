import enum  # noqa: I001
from datetime import datetime
from uuid import uuid4
from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base


class Status(enum.Enum):
    processing = "processing"
    indexed = "indexed"
    failed = "failed"


class File(Base):
    __tablename__ = "files"

    id: Mapped[uuid4] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[uuid4] = mapped_column(
        ForeignKey("users.id"), default=None)
    filename: Mapped[str] = mapped_column(nullable=False)
    file_path = Mapped[str] = mapped_column(nullable=False)
    status = Mapped[Status] = mapped_column(
        default=Status.processing, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        server_onupdate=func.now(),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
