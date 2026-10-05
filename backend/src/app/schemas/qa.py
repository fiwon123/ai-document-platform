from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.search import SearchMode, SearchResult


class QARequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000, description="Question to ask")
    document_ids: list[UUID] | None = Field(
        default=None,
        description="Specific document IDs to search (None = all documents)",
    )
    model: str | None = Field(
        default=None,
        description=(
            "Model override. When omitted, a free configured model is "
            "used (see /qa/models for what is available), and a paid "
            "OpenAI model only if nothing free is configured."
        ),
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
    mode: SearchMode = Field(
        default=SearchMode.semantic,
        description=(
            "Retrieval mode used to build the context. `keyword` means no "
            "embedding provider is configured, so the passages handed to the "
            "model were found by literal matching and relevant ones may be "
            "missing from the answer."
        ),
    )
