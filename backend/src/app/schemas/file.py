from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.models.file import Status


class CreateFileRequest(BaseModel):
    filename: str
    file_path: str


class UpdateFileRequest(BaseModel):
    filename: str
    file_path: str
    status: Status


class FileResponse(BaseModel):
    id: UUID
    user_id: UUID
    filename: str
    file_path: str
    status: Status
    updated_at: datetime
    created_at: datetime
