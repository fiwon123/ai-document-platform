import hashlib
import logging
import os
import re
from uuid import UUID

from openai import OpenAI

from app.cache.redis import redis_client
from app.schemas.document import QAResponse, SearchResult
from app.services.search import SearchService, user_cache_version

logger = logging.getLogger(__name__)

# Redact anything that looks like an API key inside logged provider errors
# (OpenAI/Groq messages may echo the key prefix).
_KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9_-]+")

# Cached answers are served for QA_TTL_SECONDS seconds; the user's cache
# version (bumped on document upload/delete/processing) invalidates them
# earlier when the document set changes.
QA_CACHE_TTL_SECONDS = 900  # 15 minutes
_QA_CACHE_KEY = "qa:{user_id}:{version}:{cache_id}"

# Fallback strings that must never be cached: they indicate a transient
# provider problem, missing configuration, or an empty model answer, and
# caching them would hide the recovery for the whole TTL.
_UNCACHEABLE_ANSWER_PREFIXES = (
    "AI service is not configured.",
    "Could not generate an answer with the AI provider.",
    "No answer generated.",
)

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


def _provider_base_url(provider: str) -> str | None:
    """Base URL used for a provider's OpenAI-compatible API."""
    if provider == "groq":
        return GROQ_BASE_URL
    # OpenAI — use the SDK default endpoint.
    return None


def _client_for_model(model_id: str) -> tuple[OpenAI | None, str]:
    """Resolve a model id to its provider client + provider name."""
    entry = _MODEL_BY_ID.get(model_id) or _MODEL_BY_ID[OPENAI_MODEL]
    return _provider_client(entry["provider"]), entry["provider"]


def _client_for_api_key(api_key: str, provider: str) -> OpenAI:
    """Build a throwaway client for a user-supplied API key.

    The key is used only for this one request and the client is discarded
    after the call returns — BYOK keys are never stored or logged.
    """
    return OpenAI(api_key=api_key, base_url=_provider_base_url(provider))


def _qa_cache_key(
    user_id: UUID,
    question: str,
    document_ids: list[UUID] | None,
    model: str,
    version: str | None = None,
) -> str | None:
    """Build the QA cache key: user, document-set version, and a hash of
    the normalized question + filters + model. None when Redis is
    unavailable.

    ``version`` is resolved once per request and threaded through the
    cache read and write, so a cache invalidation that lands mid-request
    cannot attach a stale answer to the *new* version key.
    """
    try:
        version = version or user_cache_version(user_id) or "0"
        normalized_question = question.strip().casefold()
        cache_id = hashlib.sha256(
            f"{normalized_question}|{sorted(map(str, document_ids or []))}|{model}".encode()
        ).hexdigest()[:16]
        return _QA_CACHE_KEY.format(user_id=user_id, version=version, cache_id=cache_id)
    except Exception as e:  # noqa: BLE001 - cache must never break QA
        logger.warning(f"QA cache key generation failed: {e}")
        return None


def _get_cached_qa(
    user_id: UUID,
    question: str,
    document_ids: list[UUID] | None,
    model: str,
    version: str | None = None,
) -> QAResponse | None:
    key = _qa_cache_key(user_id, question, document_ids, model, version=version)
    if key is None:
        return None
    try:
        payload = redis_client.get_json(key)
        if payload is None:
            return None
        return QAResponse.model_validate(payload)
    except Exception as e:  # noqa: BLE001 - fall back to a live answer
        logger.warning(f"QA cache read failed: {e}")
        return None


def _cache_qa(
    user_id: UUID,
    question: str,
    document_ids: list[UUID] | None,
    model: str,
    response: QAResponse,
    version: str | None = None,
) -> None:
    key = _qa_cache_key(user_id, question, document_ids, model, version=version)
    if key is None:
        return
    try:
        redis_client.set_json(
            key,
            response.model_dump(mode="json"),
            ex=QA_CACHE_TTL_SECONDS,
        )
    except Exception as e:  # noqa: BLE001 - cache write must never break QA
        logger.warning(f"QA cache write failed: {e}")


def _is_uncacheable_answer(answer: str) -> bool:
    """True when the answer is a fallback that must never be cached."""
    return answer.lstrip().startswith(_UNCACHEABLE_ANSWER_PREFIXES)


class QAService:
    def __init__(self, search_service: SearchService):
        self.search_service = search_service

    def ask(
        self,
        user_id: UUID,
        question: str,
        document_ids: list[UUID] | None = None,
        model: str | None = None,
        api_key: str | None = None,
    ) -> QAResponse:
        effective_model = model or OPENAI_MODEL

        # BYOK requests are never cached (key isolation + the answer may
        # differ from the server-keyed one); everything else can be served
        # from cache when the question + document set + model are identical.
        # The cache version is resolved ONCE so the read and write share a
        # version — an invalidation landing mid-request then only ever
        # orphanages the (already stale) old-version entry.
        cache_version: str | None = (
            user_cache_version(user_id) if api_key is None else None
        )
        if cache_version is not None:
            cached = _get_cached_qa(
                user_id,
                question,
                document_ids,
                effective_model,
                version=cache_version,
            )
            if cached is not None:
                return cached

        search_response = self.search_service.search(
            user_id=user_id,
            query=question,
            top_k=5,
            document_ids=document_ids,
        )

        context = self._build_context(search_response.results)

        answer = self._generate_answer(
            question=question,
            context=context,
            model=effective_model,
            api_key=api_key,
        )

        response = QAResponse(
            question=question,
            answer=answer,
            sources=search_response.results,
            model=effective_model,
        )

        if cache_version is not None and not _is_uncacheable_answer(answer):
            _cache_qa(
                user_id,
                question,
                document_ids,
                effective_model,
                response,
                version=cache_version,
            )

        return response

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
        api_key: str | None = None,
    ) -> str:
        effective_model = model or OPENAI_MODEL
        _client, provider = _client_for_model(effective_model)

        # A user-supplied key wins over the server-configured key for this
        # request only (bring-your-own-key). Without one, fall back to the
        # server-level client for the provider.
        client = (
            _client_for_api_key(api_key, provider)
            if api_key
            else _client
        )

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
            # Never echo provider internals to the user — the SDK message may
            # contain key prefixes or account hints. Log the detail (with any
            # key-shaped strings redacted) instead.
            logger.warning(
                "LLM call failed for provider %s: %s",
                provider,
                _KEY_PATTERN.sub("sk-***", str(e)),
            )
            return "Could not generate an answer with the AI provider. Please try again."