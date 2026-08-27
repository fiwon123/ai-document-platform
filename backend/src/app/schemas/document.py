from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.models.document import DocumentStatus


class FileResponse(BaseModel):
    id: UUID
    owner_id: UUID
    filename: str
    object_key: str
    mime_type: str | None
    status: DocumentStatus
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
