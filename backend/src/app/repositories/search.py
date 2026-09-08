from uuid import UUID

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

        total_count = query.count()

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

        total_count = query.count()

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

    def save_search_history(self, history: SearchHistory):
        self.db.add(history)
        self.db.commit()