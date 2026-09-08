from uuid import UUID

from app.models.document import DocumentStatus
from app.repositories.statistics import StatisticsRepository
from app.schemas.statistics import RecentDocument, StatisticsResponse


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