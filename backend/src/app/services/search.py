import hashlib
import logging
from uuid import UUID

from app.cache.redis import redis_client
from app.models.search import SearchHistory
from app.repositories.search import SearchRepository
from app.schemas.search import SearchMode, SearchResponse
from app.services.embedding import EmbeddingService

logger = logging.getLogger(__name__)

SEARCH_CACHE_TTL_SECONDS = 300
_SEARCH_VERSION_KEY = "search_version:{user_id}"
_SEARCH_KEY = "search:{user_id}:{version}:{cache_id}"


def user_cache_version(user_id: UUID) -> str | None:
    """Return the user's current cache generation.

    Every cache that depends on a user's document set (search results,
    QA answers, dashboard statistics) includes this version in its key.
    ``invalidate_user_search_cache`` bumps it, so a single version key
    invalidates all of them together. Returns None when Redis is
    unavailable — callers must then bypass the cache.
    """
    try:
        return (
            redis_client.get(_SEARCH_VERSION_KEY.format(user_id=user_id)) or "0"
        )
    except Exception as e:  # noqa: BLE001 - cache must never break callers
        logger.warning(f"Cache version read failed: {e}")
        return None


def _search_cache_key(
    user_id: UUID,
    query: str,
    top_k: int,
    offset: int,
    document_ids: list[UUID] | None,
) -> str | None:
    """Build the cache key for a search, including a per-user version.

    Returning None indicates Redis is unavailable — callers must then
    bypass the cache instead of failing the request.
    """
    try:
        version = user_cache_version(user_id) or "0"
        cache_id = hashlib.sha256(
            f"{query}|{top_k}|{offset}|{sorted(map(str, document_ids or []))}".encode()
        ).hexdigest()[:16]
        return _SEARCH_KEY.format(user_id=user_id, version=version, cache_id=cache_id)
    except Exception as e:  # noqa: BLE001 - cache must never break search
        logger.warning(f"Search cache key generation failed: {e}")
        return None


def _get_cached_search(
    user_id: UUID,
    query: str,
    top_k: int,
    offset: int,
    document_ids: list[UUID] | None,
) -> SearchResponse | None:
    key = _search_cache_key(user_id, query, top_k, offset, document_ids)
    if key is None:
        return None
    try:
        payload = redis_client.get_json(key)
        if payload is None:
            return None
        return SearchResponse.model_validate(payload)
    except Exception as e:  # noqa: BLE001 - fall back to a live search
        logger.warning(f"Search cache read failed: {e}")
        return None


def _cache_search(
    user_id: UUID,
    query: str,
    top_k: int,
    offset: int,
    document_ids: list[UUID] | None,
    response: SearchResponse,
) -> None:
    key = _search_cache_key(user_id, query, top_k, offset, document_ids)
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
        offset: int = 0,
        document_ids: list[UUID] | None = None,
        record_history: bool = True,
    ) -> SearchResponse:
        cached = _get_cached_search(user_id, query, top_k, offset, document_ids)
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

        results, total_count = self.repository.search(
            user_id=user_id,
            query_embedding=query_embedding,
            # The keyword fallback has no embedding to work from, so the query
            # text itself is the only thing it can match against. It used to be
            # dropped here, which is how the fallback ended up returning the
            # user's first chunks regardless of the question (#451).
            query_text=query,
            top_k=top_k,
            offset=offset,
            document_ids=document_ids,
        )

        if record_history:
            search_history = SearchHistory(
                user_id=user_id,
                query=query,
                results_count=total_count,
            )
            self.repository.save_search_history(search_history)

        response = SearchResponse(
            query=query,
            results=results,
            total_count=total_count,
            has_more=offset + len(results) < total_count,
            # `query_embedding is None` is already the branch the repository
            # took, so reporting it costs nothing and cannot disagree with what
            # actually happened.
            mode=(
                SearchMode.semantic
                if query_embedding is not None
                else SearchMode.keyword
            ),
        )
        _cache_search(user_id, query, top_k, offset, document_ids, response)
        return response