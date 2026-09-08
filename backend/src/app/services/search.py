import logging
from uuid import UUID

from app.models.search import SearchHistory
from app.repositories.search import SearchRepository
from app.schemas.document import SearchResponse
from app.services.embedding import EmbeddingService

logger = logging.getLogger(__name__)


class SearchService:
    def __init__(
        self,
        repository: SearchRepository,
        embedding_service: EmbeddingService | None = None,
    ):
        self.repository = repository
        self.embedding_service = embedding_service or EmbeddingService()

    def search(
        self,
        user_id: UUID,
        query: str,
        top_k: int = 5,
    ) -> SearchResponse:
        # Generate a query embedding so the repository can run semantic
        # (vector) search. Falls back to plain text search when embedding
        # generation is unavailable (no API key, API error, etc.).
        query_embedding = None
        try:
            query_embedding = self.embedding_service.generate_embedding(query)
        except Exception as e:  # noqa: BLE001 - graceful fallback to text search
            logger.warning(
                f"Query embedding unavailable, falling back to text search: {e}"
            )

        results = self.repository.search(
            user_id=user_id,
            query_embedding=query_embedding,
            top_k=top_k,
        )

        search_history = SearchHistory(
            user_id=user_id,
            query=query,
            results_count=len(results),
        )
        self.repository.save_search_history(search_history)

        return SearchResponse(query=query, results=results)