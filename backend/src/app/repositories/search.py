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

    def _text_search(
        self,
        user_id: UUID,
        top_k: int,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
    ) -> tuple[list[SearchResult], int]:
        query = (
            self.db.query(DocumentChunk, DocumentDB.filename)
            .join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
            .filter(DocumentDB.owner_id == user_id)
        )
        if document_ids:
            query = query.filter(DocumentDB.id.in_(document_ids))

        total_count = self._count_matching_chunks(
            user_id=user_id,
            document_ids=document_ids,
            require_embedding=False,
        )

        rows = (
            query.order_by(DocumentChunk.chunk_index, DocumentChunk.id)
            .offset(offset)
            .limit(top_k)
            .all()
        )

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
                for chunk, filename in rows
            ],
            total_count,
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

        query = (
            self.db.query(DocumentChunk, DocumentDB.filename, distance.label("score"))
            .join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
            .filter(DocumentDB.owner_id == user_id)
            .filter(DocumentChunk.embedding.isnot(None))
        )
        if document_ids:
            query = query.filter(DocumentDB.id.in_(document_ids))

        total_count = self._count_matching_chunks(
            user_id=user_id,
            document_ids=document_ids,
            require_embedding=True,
        )

        rows = query.order_by(distance).offset(offset).limit(top_k).all()

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
                for chunk, filename, score in rows
            ],
            total_count,
        )

    def _count_matching_chunks(
        self,
        user_id: UUID,
        document_ids: list[UUID] | None = None,
        require_embedding: bool = False,
    ) -> int:
        """Count chunks matching the user's filters without heavy work.

        ``query.count()`` on the vector query materializes each row's
        cosine distance (and the ORDER BY) just to count it. This count
        selects only ``count(*)`` over the joined, filtered rows, so the
        database skips the distance computation entirely. This matters
        most for paginated vector searches over large corpora.
        """
        count_query = (
            self.db.query(func.count(DocumentChunk.id))
            .join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
            .filter(DocumentDB.owner_id == user_id)
        )
        if require_embedding:
            count_query = count_query.filter(DocumentChunk.embedding.isnot(None))
        if document_ids:
            count_query = count_query.filter(DocumentDB.id.in_(document_ids))
        return count_query.scalar() or 0

    def save_search_history(self, history: SearchHistory):
        self.db.add(history)
        self.db.commit()