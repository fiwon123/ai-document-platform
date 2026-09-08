from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.models.document import DocumentStatus


class RecentDocument(BaseModel):
    id: UUID
    filename: str
    status: DocumentStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class StatisticsResponse(BaseModel):
    """Workspace summary for the dashboard (scoped to the current user)."""

    total_documents: int
    pending_documents: int
    processing_documents: int
    ready_documents: int
    failed_documents: int
    total_chunks: int
    recent_documents: list[RecentDocument]