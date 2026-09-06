from uuid import UUID

from app.models.search import SearchHistory
from app.repositories.search import SearchRepository
from app.schemas.document import SearchResult, SearchResponse


class SearchService:
    def __init__(self, repository: SearchRepository):
        self.repository = repository

    def search(
        self,
        user_id: UUID,
        query: str,
        top_k: int = 5,
    ) -> SearchResponse:
        results = self.repository.search(
            user_id=user_id,
            query_embedding=None,
            top_k=top_k,
        )

        search_history = SearchHistory(
            user_id=user_id,
            query=query,
            results_count=len(results),
        )
        self.repository.save_search_history(search_history)

        return SearchResponse(query=query, results=results)

    def search_with_embedding(
        self,
        user_id: UUID,
        query: str,
        query_embedding: list[float],
        top_k: int = 5,
    ) -> SearchResponse:
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
