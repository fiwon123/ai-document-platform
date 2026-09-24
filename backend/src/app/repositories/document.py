import math
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.document import DocumentDB, DocumentStatus


class DocumentRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_by_id(
        self,
        document_id: UUID,
        owner_id: UUID | None = None,
    ):
        query = self.db.query(DocumentDB).filter(DocumentDB.id == document_id)
        if owner_id is not None:
            query = query.filter(DocumentDB.owner_id == owner_id)
        return query.first()

    def get_preview_chunks(
        self,
        document_id: UUID,
        *,
        max_chars: int = 5000,
    ) -> list[str]:
        """Return chunk contents (oldest first) enough to build a preview.

        Chunking uses a sliding window with an overlap, so a preview of
        ``max_chars`` needs at most
        ``ceil(max_chars / (chunk_size - overlap))`` windows; the extra
        rows absorb overlap/break-point drift and reuse across configs.
        Only the ``content`` column is read (embeddings are never loaded).
        """
        from app.models.chunk import DocumentChunk

        # Mirrors ChunkingService defaults; the over-fetch makes the exact
        # values non-critical here.
        chunk_size, chunk_overlap = 1000, 200
        per_window = max(chunk_size - chunk_overlap, 1)
        fetch_limit = math.ceil(max_chars / per_window) + 3

        rows = (
            self.db.query(DocumentChunk.content)
            .filter(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.chunk_index.asc())
            .limit(fetch_limit)
            .all()
        )
        return [row[0] for row in rows]

    def get_by_owner(self, owner_id: UUID, skip: int = 0, limit: int = 20):
        return (
            self.db.query(DocumentDB)
            .filter(DocumentDB.owner_id == owner_id)
            .order_by(DocumentDB.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def create(self, document: DocumentDB):
        self.db.add(document)
        self.db.commit()
        self.db.refresh(document)
        return document

    def delete(self, document: DocumentDB):
        self.db.delete(document)
        self.db.commit()

    def update_status(
        self,
        document_id: UUID,
        status: DocumentStatus,
        error_message: str | None = None,
    ):
        document = self.get_by_id(document_id)
        if document is None:
            return None

        document.status = status
        document.error_message = error_message
        self.db.commit()
        self.db.refresh(document)
        return document
