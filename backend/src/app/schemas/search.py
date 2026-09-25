from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field


class SearchExportFormat(StrEnum):
    """Supported export serialization formats for search results."""

    csv = "csv"
    json = "json"


class SearchExportRequest(BaseModel):
    """Request to export search results as a downloadable file."""

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
    format: SearchExportFormat = Field(
        default=SearchExportFormat.csv,
        description="Output format: csv or json",
    )


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
