import os
from uuid import UUID

from openai import OpenAI

from app.schemas.document import QAResponse, SearchResult
from app.services.search import SearchService

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4")

# Groq serves Llama & friends through an OpenAI-compatible API. Model IDs
# on Groq are free to use (free-tier rate limits apply) — only a free
# GROQ_API_KEY from console.groq.com is needed, no OpenAI subscription.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Central registry of QA models. Each entry:
#   id       — the model id sent to the provider API
#   label    — human-friendly name (shown in the Settings picker)
#   provider — "openai" | "groq", selects the API key + base_url
#   tier     — "free" | "paid", drives the /qa/models grouping
MODEL_REGISTRY: list[dict] = [
    {
        "id": "gpt-4o-mini",
        "label": "GPT-4o mini (fast, cheap)",
        "provider": "openai",
        "tier": "free",
    },
    {
        "id": "llama-3.3-70b-versatile",
        "label": "Llama 3.3 70B (Groq, free)",
        "provider": "groq",
        "tier": "free",
    },
    {
        "id": "llama-3.1-8b-instant",
        "label": "Llama 3.1 8B (Groq, free)",
        "provider": "groq",
        "tier": "free",
    },
    {
        "id": "gpt-4o",
        "label": "GPT-4o",
        "provider": "openai",
        "tier": "paid",
    },
    {
        "id": "gpt-4",
        "label": "GPT-4",
        "provider": "openai",
        "tier": "paid",
    },
    {
        "id": "gpt-4-turbo",
        "label": "GPT-4 Turbo",
        "provider": "openai",
        "tier": "paid",
    },
]

# Snapshot views used by the routes and tests (kept as module constants so
# existing imports keep working).
AVAILABLE_MODELS = [entry["id"] for entry in MODEL_REGISTRY]
FREE_MODELS = [entry["id"] for entry in MODEL_REGISTRY if entry["tier"] == "free"]

_MODEL_BY_ID = {entry["id"]: entry for entry in MODEL_REGISTRY}

_openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
_groq_client = (
    OpenAI(api_key=GROQ_API_KEY, base_url=GROQ_BASE_URL) if GROQ_API_KEY else None
)

# Friendly hint when a provider's API key is missing.
_PROVIDER_KEY_HINT = {
    "openai": "Set the OPENAI_API_KEY environment variable to use OpenAI models.",
    "groq": (
        "Set the GROQ_API_KEY environment variable (free key from "
        "https://console.groq.com) to use free Groq models."
    ),
}


def _provider_client(provider: str) -> OpenAI | None:
    """Return the client for a provider.

    Reads the module attribute at call time so tests can monkeypatch
    either client independently.
    """
    if provider == "groq":
        return _groq_client
    return _openai_client


def _client_for_model(model_id: str) -> tuple[OpenAI | None, str]:
    """Resolve a model id to its provider client + provider name."""
    entry = _MODEL_BY_ID.get(model_id) or _MODEL_BY_ID[OPENAI_MODEL]
    return _provider_client(entry["provider"]), entry["provider"]


class QAService:
    def __init__(self, search_service: SearchService):
        self.search_service = search_service

    def ask(
        self,
        user_id: UUID,
        question: str,
        document_ids: list[UUID] | None = None,
        model: str | None = None,
    ) -> QAResponse:
        search_response = self.search_service.search(
            user_id=user_id,
            query=question,
            top_k=5,
            document_ids=document_ids,
        )

        context = self._build_context(search_response.results)

        effective_model = model or OPENAI_MODEL
        answer = self._generate_answer(
            question=question,
            context=context,
            model=effective_model,
        )

        return QAResponse(
            question=question,
            answer=answer,
            sources=search_response.results,
            model=effective_model,
        )

    @staticmethod
    def list_models() -> dict:
        """Available QA models split into free and paid tiers."""
        return {
            "free": FREE_MODELS,
            "paid": [m for m in AVAILABLE_MODELS if m not in FREE_MODELS],
        }

    def _build_context(self, results: list[SearchResult]) -> str:
        if not results:
            return "No relevant documents found."

        context_parts = []
        for i, result in enumerate(results, 1):
            context_parts.append(
                f"[Source {i}] Document: {result.document_filename}\n"
                f"{result.content}"
            )

        return "\n\n".join(context_parts)

    def _generate_answer(
        self,
        question: str,
        context: str,
        model: str | None = None,
    ) -> str:
        effective_model = model or OPENAI_MODEL
        client, provider = _client_for_model(effective_model)

        if client is None:
            return (
                "AI service is not configured. "
                + _PROVIDER_KEY_HINT[provider]
            )

        system_prompt = (
            "You are a helpful assistant that answers questions based on "
            "the provided document context. If the context doesn't contain "
            "enough information to answer the question, say so clearly. "
            "Always cite which document(s) you used for your answer."
        )

        user_prompt = (
            f"Context from documents:\n\n{context}\n\n"
            f"Question: {question}\n\n"
            f"Please provide a helpful answer based on the context above."
        )

        try:
            response = client.chat.completions.create(
                model=effective_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                max_tokens=1000,
            )
            return response.choices[0].message.content or "No answer generated."
        except Exception as e:
            return f"Error generating answer: {str(e)}"