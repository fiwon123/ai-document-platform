from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB
from app.models.search import SearchHistory
from app.schemas.document import SearchResult


class SearchRepository:
    def __init__(self, db: Session):
        self.db = db

    def search(
        self,
        user_id: UUID,
        query_embedding: list[float] | None,
        top_k: int = 5,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
    ) -> tuple[list[SearchResult], int]:
        """Run a search and return ``(page_of_results, total_count)``."""
        if query_embedding is None:
            return self._text_search(
                user_id=user_id,
                top_k=top_k,
                offset=offset,
                document_ids=document_ids,
            )
        return self._vector_search(
            user_id=user_id,
            query_embedding=query_embedding,
            top_k=top_k,
            offset=offset,
            document_ids=document_ids,
        )

    @staticmethod
    def _apply_user_filter(query, user_id: UUID, document_ids: list[UUID] | None):
        """Restrict a search query to the user's own (optionally filtered)
        documents."""
        query = query.filter(DocumentDB.owner_id == user_id)
        if document_ids:
            query = query.filter(DocumentDB.id.in_(document_ids))
        return query

    def _text_search(
        self,
        user_id: UUID,
        top_k: int,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
    ) -> tuple[list[SearchResult], int]:
        # COUNT(*) OVER () computes the total matching rows in the same
        # query that returns the page, avoiding a second round trip.
        query = (
            self.db.query(
                DocumentChunk,
                DocumentDB.filename,
                func.count().over().label("total_count"),
            )
            .join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
        )
        query = self._apply_user_filter(query, user_id, document_ids)

        rows = (
            query.order_by(DocumentChunk.chunk_index, DocumentChunk.id)
            .offset(offset)
            .limit(top_k)
            .all()
        )
        total_count = rows[0].total_count if rows else 0

        return (
            [
                SearchResult(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    document_filename=filename,
                    content=chunk.content,
                    score=0.0,
                    metadata_=chunk.metadata_,
                )
                for chunk, filename, _ in rows
            ],
            int(total_count),
        )

    def _vector_search(
        self,
        user_id: UUID,
        query_embedding: list[float],
        top_k: int,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
    ) -> tuple[list[SearchResult], int]:
        distance = DocumentChunk.embedding.cosine_distance(query_embedding)

        query = self.db.query(
            DocumentChunk,
            DocumentDB.filename,
            distance.label("score"),
            func.count().over().label("total_count"),
        ).join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
        query = query.filter(DocumentChunk.embedding.isnot(None))
        query = self._apply_user_filter(query, user_id, document_ids)

        rows = query.order_by(distance, DocumentChunk.id).offset(offset).limit(top_k).all()
        total_count = rows[0].total_count if rows else 0

        return (
            [
                SearchResult(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    document_filename=filename,
                    content=chunk.content,
                    score=float(score),
                    metadata_=chunk.metadata_,
                )
                for chunk, filename, score, _ in rows
            ],
            int(total_count),
        )

    def save_search_history(self, history: SearchHistory):
        self.db.add(history)
        self.db.commit()