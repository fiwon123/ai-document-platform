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
    score: float = Field(
        description=(
            "Relevance **distance** in the range 0 to 1, where **smaller is a "
            "better match** and 1.0 is the furthest possible match. This is the "
            "name the field has always had, but it is a distance, not a "
            "similarity: results are ordered by it ascending, and a high value "
            "means a poor match rather than a good one. Convert it to a "
            "similarity percentage with `(1 - score) * 100`, which is what the "
            "web UI displays. The exact metric depends on the search `mode`: "
            "`semantic` reports a cosine distance between embeddings, while "
            "`keyword` reports a full-text rank distance. Only the ordering "
            "within one result set is meaningful; distances from two different "
            "searches are not comparable."
        )
    )
    metadata_: dict | None = None


class SearchMode(StrEnum):
    """How a set of results was found.

    Reported rather than left implicit: without an embedding provider the
    platform silently falls back to keyword matching, and a `READY` document
    with no vectors looks exactly like a fully indexed one. A user seeing worse
    results has no way to tell a bad query from a missing index, so the response
    says which mode produced it.
    """

    semantic = "semantic"
    keyword = "keyword"


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    total_count: int = Field(
        description=(
            "Total number of results matching the query for this user, ignoring "
            "pagination. In `keyword` mode this counts only chunks whose text "
            "actually matches, so a query that matches nothing reports 0 rather "
            "than the size of the corpus."
        )
    )
    has_more: bool = Field(
        description=(
            "True when more matching results exist beyond this page. Fetch the "
            "next page with `offset = offset + len(results)`."
        )
    )
    mode: SearchMode = Field(
        default=SearchMode.semantic,
        description=(
            "Search mode used for these results. `keyword` means no embedding "
            "provider is configured, so matching is literal rather than "
            "semantic and recall will be worse."
        ),
    )
