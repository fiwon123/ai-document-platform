from uuid import UUID

from app.models.document import DocumentStatus
from app.repositories.statistics import StatisticsRepository
from app.schemas.statistics import (
    AdminStatisticsResponse,
    RecentDocument,
    StatisticsResponse,
)


class StatisticsService:
    """Assembles the dashboard summary for the current user."""

    def __init__(self, repository: StatisticsRepository):
        self.repository = repository

    def get_summary(self, owner_id: UUID) -> StatisticsResponse:
        counts = self.repository.status_counts(owner_id)

        recent = self.repository.recent_documents(owner_id)

        return StatisticsResponse(
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

    def get_admin_summary(self) -> AdminStatisticsResponse:
        """System-wide aggregates for admins (all users, all documents)."""
        users = self.repository.user_status_counts()
        documents = self.repository.all_status_counts()

        return AdminStatisticsResponse(
            total_users=sum(users.values()),
            active_users=users.get(True, 0),
            disabled_users=users.get(False, 0),
            total_documents=sum(documents.values()),
            pending_documents=documents.get(DocumentStatus.PENDING, 0),
            processing_documents=documents.get(DocumentStatus.PROCESSING, 0),
            ready_documents=documents.get(DocumentStatus.READY, 0),
            failed_documents=documents.get(DocumentStatus.FAILED, 0),
            total_chunks=self.repository.all_chunk_count(),
            total_searches=self.repository.search_count(),
        )