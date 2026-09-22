from collections import Counter
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.search import SearchHistory
from app.models.user import UserDB


class StatisticsRepository:
    """Aggregation queries for the dashboard statistics endpoint."""

    def __init__(self, db: Session):
        self.db = db

    def status_counts(self, owner_id: UUID) -> dict[DocumentStatus, int]:
        """Count documents per status for the given owner."""
        rows = self.db.execute(
            select(DocumentDB.status, func.count(DocumentDB.id))
            .where(DocumentDB.owner_id == owner_id)
            .group_by(DocumentDB.status)
        ).all()
        return Counter(dict(rows))

    def chunk_count(self, owner_id: UUID) -> int:
        """Total number of chunks belonging to the owner's documents."""
        return (
            self.db.scalar(
                select(func.count(DocumentChunk.id))
                .join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
                .where(DocumentDB.owner_id == owner_id)
            )
            or 0
        )

    def recent_documents(
        self,
        owner_id: UUID,
        limit: int = 5,
    ) -> list[DocumentDB]:
        return list(
            self.db.scalars(
                select(DocumentDB)
                .where(DocumentDB.owner_id == owner_id)
                .order_by(DocumentDB.created_at.desc())
                .limit(limit)
            ).all()
        )

    # --- Admin (system-wide) aggregations -------------------------------

    def user_status_counts(self) -> dict[bool, int]:
        """Count users by is_active flag across the whole system."""
        rows = self.db.execute(
            select(UserDB.is_active, func.count(UserDB.id)).group_by(
                UserDB.is_active
            )
        ).all()
        return dict(rows)

    def all_status_counts(self) -> dict[DocumentStatus, int]:
        """Count documents per status across all users."""
        rows = self.db.execute(
            select(DocumentDB.status, func.count(DocumentDB.id)).group_by(
                DocumentDB.status
            )
        ).all()
        return dict(rows)

    def all_chunk_count(self) -> int:
        """Total number of indexed chunks in the system."""
        return self.db.scalar(select(func.count(DocumentChunk.id))) or 0

    def all_search_count(self) -> int:
        """Total number of recorded searches across all users."""
        return self.db.scalar(select(func.count(SearchHistory.id))) or 0