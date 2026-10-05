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
    has_thumbnail: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentStatusResponse(BaseModel):
    """Minimal status payload for clients that poll processing state.

    ``created_at``/``updated_at`` let the client show how long a document has
    been in its current state (``updated_at`` is refreshed on every status
    transition, so while pending/processing it is the transition time).
    """

    id: UUID
    status: DocumentStatus
    error_message: str | None = None
    has_thumbnail: bool = False
    created_at: datetime
    updated_at: datetime


class DocumentChunkResponse(BaseModel):
    id: UUID
    document_id: UUID
    content: str
    chunk_index: int
    metadata_: dict | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentPreviewResponse(BaseModel):
    """Text preview of a stored document (owner-scoped, truncated)."""

    id: UUID
    filename: str
    preview: str
    truncated: bool


class DownloadUrlResponse(BaseModel):
    """Typed payload for the presigned download URL endpoint."""

    id: UUID
    filename: str
    download_url: str


class ThumbnailUrlResponse(BaseModel):
    """Typed payload for the presigned thumbnail URL endpoint."""

    id: UUID
    thumbnail_url: str


class DeleteDocumentResponse(BaseModel):
    """Typed payload for the document delete endpoint."""

    message: str
    document_id: UUID


class ReprocessDocumentResponse(BaseModel):
    """Confirmation that a failed/ready document was re-enqueued for processing."""

    message: str
    document_id: UUID
    status: DocumentStatus


class BulkUploadFailure(BaseModel):
    """Per-file error entry for a bulk upload."""

    filename: str
    error: str


class BulkUploadResponse(BaseModel):
    """Result of a bulk upload: successfully stored files and per-file failures."""

    uploaded: list[FileResponse]
    failed: list[BulkUploadFailure]
