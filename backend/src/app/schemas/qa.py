from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.search import SearchResult


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
