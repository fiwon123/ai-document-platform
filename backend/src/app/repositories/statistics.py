from collections import Counter
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus


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