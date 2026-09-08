import hashlib
import logging
from uuid import UUID

from app.cache.redis import redis_client
from app.models.search import SearchHistory
from app.repositories.search import SearchRepository
from app.schemas.document import SearchResponse, SearchResult
from app.services.embedding import EmbeddingService

logger = logging.getLogger(__name__)

SEARCH_CACHE_TTL_SECONDS = 300
_SEARCH_VERSION_KEY = "search_version:{user_id}"
_SEARCH_KEY = "search:{user_id}:{version}:{cache_id}"


def _search_cache_key(
    user_id: UUID,
    query: str,
    top_k: int,
    document_ids: list[UUID] | None,
) -> str | None:
    """Build the cache key for a search, including a per-user version.

    Returning None indicates Redis is unavailable — callers must then
    bypass the cache instead of failing the request.
    """
    try:
        version = redis_client.get(_SEARCH_VERSION_KEY.format(user_id=user_id)) or "0"
        cache_id = hashlib.sha256(
            f"{query}|{top_k}|{sorted(map(str, document_ids or []))}".encode()
        ).hexdigest()[:16]
        return _SEARCH_KEY.format(user_id=user_id, version=version, cache_id=cache_id)
    except Exception as e:  # noqa: BLE001 - cache must never break search
        logger.warning(f"Search cache key generation failed: {e}")
        return None


def _get_cached_search(
    user_id: UUID,
    query: str,
    top_k: int,
    document_ids: list[UUID] | None,
) -> SearchResponse | None:
    key = _search_cache_key(user_id, query, top_k, document_ids)
    if key is None:
        return None
    try:
        payload = redis_client.get_json(key)
        if payload is None:
            return None
        results = [SearchResult.model_validate(item) for item in payload["results"]]
        return SearchResponse(query=query, results=results)
    except Exception as e:  # noqa: BLE001 - fall back to a live search
        logger.warning(f"Search cache read failed: {e}")
        return None


def _cache_search(
    user_id: UUID,
    query: str,
    top_k: int,
    document_ids: list[UUID] | None,
    response: SearchResponse,
) -> None:
    key = _search_cache_key(user_id, query, top_k, document_ids)
    if key is None:
        return
    try:
        redis_client.set_json(
            key,
            response.model_dump(mode="json"),
            ex=SEARCH_CACHE_TTL_SECONDS,
        )
    except Exception as e:  # noqa: BLE001 - cache write must never break search
        logger.warning(f"Search cache write failed: {e}")


def invalidate_user_search_cache(user_id: UUID) -> None:
    """Bump the user's cache version so all cached searches go stale.

    Called whenever the user's document set changes (upload, delete,
    processing completes/fails) so new documents become visible in
    search immediately instead of waiting for the TTL to expire.
    """
    try:
        redis_client.increment(_SEARCH_VERSION_KEY.format(user_id=user_id))
    except Exception as e:  # noqa: BLE001 - cache must never break the caller
        logger.warning(f"Search cache invalidation failed: {e}")


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
        document_ids: list[UUID] | None = None,
    ) -> SearchResponse:
        cached = _get_cached_search(user_id, query, top_k, document_ids)
        if cached is not None:
            # A cached search was already recorded in history the first
            # time it ran, so there is no need to write it again.
            return cached

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
            document_ids=document_ids,
        )

        search_history = SearchHistory(
            user_id=user_id,
            query=query,
            results_count=len(results),
        )
        self.repository.save_search_history(search_history)

        response = SearchResponse(query=query, results=results)
        _cache_search(user_id, query, top_k, document_ids, response)
        return response