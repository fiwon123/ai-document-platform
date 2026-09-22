import logging
from uuid import UUID

from app.cache.redis import redis_client
from app.models.document import DocumentStatus
from app.repositories.statistics import StatisticsRepository
from app.schemas.statistics import (
    AdminStatisticsResponse,
    RecentDocument,
    StatisticsResponse,
)
from app.services.search import user_cache_version

logger = logging.getLogger(__name__)

# The dashboard polls these endpoints, and re-running the aggregate
# queries on every poll is wasteful. User statistics are version-keyed
# (invalidated on document changes like the rest of the user caches);
# the admin statistics span all users, so a short TTL is their
# invalidation mechanism.
USER_STATS_CACHE_TTL_SECONDS = 60
ADMIN_STATS_CACHE_TTL_SECONDS = 30
_ME_KEY = "stats:me:{user_id}:{version}"
_ADMIN_KEY = "stats:admin"


def _get_cached_json(key: str):
    """Fetch and JSON-decode a cached payload; None on miss or failure."""
    try:
        return redis_client.get_json(key)
    except Exception as e:  # noqa: BLE001 - cache must never break stats
        logger.warning(f"Statistics cache read failed: {e}")
        return None


def _set_cached_json(key: str, value, ex: int) -> None:
    try:
        redis_client.set_json(key, value, ex=ex)
    except Exception as e:  # noqa: BLE001 - cache write must never break stats
        logger.warning(f"Statistics cache write failed: {e}")


class StatisticsService:
    """Assembles the dashboard summary for the current user."""

    def __init__(self, repository: StatisticsRepository):
        self.repository = repository

    def get_summary(self, owner_id: UUID) -> StatisticsResponse:
        key = _me_cache_key(owner_id)
        cached = _get_cached_json(key) if key else None
        if cached is not None:
            return StatisticsResponse.model_validate(cached)

        counts = self.repository.status_counts(owner_id)

        recent = self.repository.recent_documents(owner_id)

        response = StatisticsResponse(
            total_documents=sum(counts.values()),
            pending_documents=counts.get(DocumentStatus.PENDING, 0),
            processing_documents=counts.get(DocumentStatus.PROCESSING, 0),
            ready_documents=counts.get(DocumentStatus.READY, 0),
            failed_documents=counts.get(DocumentStatus.FAILED, 0),
            total_chunks=self.repository.chunk_count(owner_id),
            recent_documents=[
                RecentDocument.model_validate(document) for document in recent
            ],
        )

        if key is not None:
            _set_cached_json(
                key,
                response.model_dump(mode="json"),
                ex=USER_STATS_CACHE_TTL_SECONDS,
            )
        return response

    def get_admin_summary(self) -> AdminStatisticsResponse:
        """System-wide aggregates for admins (all users, all documents)."""
        cached = _get_cached_json(_ADMIN_KEY)
        if cached is not None:
            return AdminStatisticsResponse.model_validate(cached)

        users = self.repository.user_status_counts()
        documents = self.repository.all_status_counts()

        response = AdminStatisticsResponse(
            total_users=sum(users.values()),
            active_users=users.get(True, 0),
            disabled_users=users.get(False, 0),
            total_documents=sum(documents.values()),
            pending_documents=documents.get(DocumentStatus.PENDING, 0),
            processing_documents=documents.get(DocumentStatus.PROCESSING, 0),
            ready_documents=documents.get(DocumentStatus.READY, 0),
            failed_documents=documents.get(DocumentStatus.FAILED, 0),
            total_chunks=self.repository.all_chunk_count(),
            total_searches=self.repository.all_search_count(),
        )
        _set_cached_json(
            _ADMIN_KEY,
            response.model_dump(mode="json"),
            ex=ADMIN_STATS_CACHE_TTL_SECONDS,
        )
        return response


def _me_cache_key(owner_id: UUID) -> str | None:
    """Key for the user dashboard summary; None when Redis is unavailable."""
    version = user_cache_version(owner_id)
    if version is None:
        return None
    return _ME_KEY.format(user_id=owner_id, version=version)