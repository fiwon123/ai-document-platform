from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

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


class DocumentStatusResponse(BaseModel):
    """Minimal status payload for clients that poll processing state."""

    id: UUID
    status: DocumentStatus
    error_message: str | None = None


class DocumentChunkResponse(BaseModel):
    id: UUID
    document_id: UUID
    content: str
    chunk_index: int
    metadata_: dict | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000, description="Search query")
    top_k: int = Field(default=5, ge=1, le=20, description="Number of results")
    offset: int = Field(
        default=0,
        ge=0,
        description="Number of results to skip (pagination cursor)",
    )
    document_ids: list[UUID] | None = Field(
        default=None,
        description=(
            "Optional document IDs to restrict the search to. "
            "None (default) searches all of the user's documents."
        ),
    )


class SearchResult(BaseModel):
    chunk_id: UUID
    document_id: UUID
    document_filename: str
    content: str
    score: float
    metadata_: dict | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    total_count: int
    has_more: bool


class QARequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000, description="Question to ask")
    document_ids: list[UUID] | None = Field(
        default=None,
        description="Specific document IDs to search (None = all documents)",
    )
    model: str | None = Field(
        default=None,
        description="Model override; defaults to OPENAI_MODEL",
    )
    api_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description=(
            "Optional bring-your-own-key. When provided, the user's key is "
            "used for this request instead of the server's key for the "
            "chosen provider. Never stored or logged."
        ),
    )


class QAResponse(BaseModel):
    question: str
    answer: str
    sources: list[SearchResult]
    model: str | None = Field(
        default=None,
        description="Model that produced the answer",
    )


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


class DeleteDocumentResponse(BaseModel):
    """Typed payload for the document delete endpoint."""

    message: str
    document_id: UUID
