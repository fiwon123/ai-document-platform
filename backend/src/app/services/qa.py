import hashlib
import logging
import os
import re
from collections import Counter
from uuid import UUID

from openai import OpenAI

from app.cache.redis import redis_client
from app.env import drop_blank_provider_vars
from app.schemas.qa import QAResponse
from app.schemas.search import SearchResult
from app.services.search import SearchService, user_cache_version

logger = logging.getLogger(__name__)

# Before the provider clients are constructed further down: an empty
# OPENAI_BASE_URL from the sandbox's Compose passthrough would otherwise become
# the OpenAI client's base URL. Idempotent, and the embedding service does the
# same before its own client exists.
drop_blank_provider_vars()

# Redact anything that looks like an API key inside logged provider errors
# (OpenAI/Groq messages may echo the key prefix).
_KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9_-]+")

# Cached answers are served for QA_TTL_SECONDS seconds; the user's cache
# version (bumped on document upload/delete/processing) invalidates them
# earlier when the document set changes.
QA_CACHE_TTL_SECONDS = 900  # 15 minutes
_QA_CACHE_KEY = "qa:{user_id}:{version}:{cache_id}"

# Opening of the "no provider configured" answer. Shared by the message builder
# and the uncacheable-answer check, so rewording the message cannot quietly start
# caching the fact that a key is missing for the whole TTL.
UNCONFIGURED_PREFIX = "AI service is not configured."

# Fallback strings that must never be cached: they indicate a transient
# provider problem, missing configuration, or an empty model answer, and
# caching them would hide the recovery for the whole TTL.
_UNCACHEABLE_ANSWER_PREFIXES = (
    UNCONFIGURED_PREFIX,
    "Could not generate an answer with the AI provider.",
    "No answer generated.",
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
# Blank-safe, so a variable that is *set but empty* means "not chosen" rather
# than becoming the model id. `os.getenv(name, default)` returns "" for a
# blank-but-set variable, which would leave this constant empty and turn every
# later registry lookup into a KeyError. Same reasoning as the `QA_MODEL` read
# in resolve_default_model, which strips and validates.
OPENAI_MODEL = (os.getenv("OPENAI_MODEL", "") or "").strip() or "gpt-4"

# Groq serves Llama & friends through an OpenAI-compatible API. Model IDs
# on Groq are free to use (free-tier rate limits apply) — only a free
# GROQ_API_KEY from console.groq.com is needed, no OpenAI subscription.
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# A local, keyless provider for anyone running an OpenAI-compatible server
# (Ollama is the common one). This is the only path that works with no API
# key at all, so it is the fallback when nothing else is configured.
#
# Opt-in rather than probed: discovering it would mean a network call, and a
# probe that fails (or that succeeds and is then cached stale) would either add
# latency to every request or route answers to a dead endpoint. Requiring
# LOCAL_LLM_ENABLED means "I am running a local model server" is something the
# operator states, and the hint below says exactly what to set.
LOCAL_LLM_BASE_URL = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:11434/v1")
LOCAL_LLM_MODEL = os.getenv("LOCAL_LLM_MODEL", "llama3.2:1b")
LOCAL_LLM_ENABLED = os.getenv("LOCAL_LLM_ENABLED", "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# The OpenAI SDK refuses to build a client without a key, even when the
# endpoint ignores it. Local servers do, so a placeholder is passed through and
# never leaves the machine.
_LOCAL_PLACEHOLDER_KEY = "local-no-key"

# Central registry of QA models. Each entry:
#   id       — the model id sent to the provider API
#   label    — human-friendly name (shown in the Settings picker)
#   provider — "openai" | "groq" | "local", selects the key + base_url
#   tier     — "free" | "paid": whether using it can cost the operator money
#
# "free" means *usable without paying*, not merely cheap. `gpt-4o-mini` used to
# be filed as free because it is inexpensive, but it still bills an OpenAI
# account per token, so a user reading a "free" group containing it would
# reasonably expect a working free path and get a bill instead. It is paid.
MODEL_REGISTRY: list[dict] = [
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
        "id": LOCAL_LLM_MODEL,
        "label": "Local model (no API key)",
        "provider": "local",
        "tier": "free",
    },
    {
        "id": "gpt-4o-mini",
        "label": "GPT-4o mini (cheapest paid option)",
        "provider": "openai",
        "tier": "paid",
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

def _dedupe_local_entries(registry: list[dict]) -> list[dict]:
    """Drop a local entry whose model id collides with a hosted one.

    ``LOCAL_LLM_MODEL`` is operator-supplied, so it can be pointed at an id that
    already exists. A duplicate would appear twice in every model list and make
    the id lookup resolve to whichever entry happened to come last. The hosted
    entry wins: that is the model the operator most likely meant.

    A function rather than an inline comprehension so it can be tested directly
    -- exercising it through a module reload would reset the module-level
    clients that the rest of the suite monkeypatches.
    """
    counts = Counter(entry["id"] for entry in registry)
    return [
        entry
        for entry in registry
        if not (entry["provider"] == "local" and counts[entry["id"]] > 1)
    ]


# Snapshot views used by the routes and tests (kept as module constants so
# existing imports keep working).
MODEL_REGISTRY = _dedupe_local_entries(MODEL_REGISTRY)

AVAILABLE_MODELS = [entry["id"] for entry in MODEL_REGISTRY]
FREE_MODELS = [entry["id"] for entry in MODEL_REGISTRY if entry["tier"] == "free"]

_MODEL_BY_ID = {entry["id"]: entry for entry in MODEL_REGISTRY}

_openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
_groq_client = (
    OpenAI(api_key=GROQ_API_KEY, base_url=GROQ_BASE_URL) if GROQ_API_KEY else None
)
# Built whenever the local provider is enabled, key or no key: the endpoint
# ignores the placeholder, so requiring a key here would defeat the point.
_local_client = (
    OpenAI(api_key=_LOCAL_PLACEHOLDER_KEY, base_url=LOCAL_LLM_BASE_URL)
    if LOCAL_LLM_ENABLED
    else None
)

# How to turn each provider on, and what it costs.
#
# Kept apart from MODEL_REGISTRY on purpose: the registry says which models exist
# and which tier they are, this says what the operator has to set and in what
# order the options should be offered. The order is *derived* from the registry
# rather than written out again here, and a test asserts every registry provider
# has a row here, so a provider cannot be added to one and forgotten in the
# other.
#
# The hint used to be keyed by the resolved provider only, which is why a server
# with nothing configured pointed the reader at `OPENAI_API_KEY` — the one
# option that costs money — and said nothing about the two that do not.
_PROVIDER_SETUP: dict[str, dict[str, str]] = {
    "groq": {
        "name": "Groq",
        "cost": "free",
        "how": (
            "set GROQ_API_KEY to a free key from https://console.groq.com — "
            "no OpenAI subscription needed"
        ),
    },
    "local": {
        "name": "Local model",
        "cost": "free, no API key",
        "how": (
            "set LOCAL_LLM_ENABLED=true and LOCAL_LLM_MODEL to any "
            "OpenAI-compatible local server, such as Ollama"
        ),
    },
    "openai": {
        "name": "OpenAI",
        "cost": "paid — bills your OpenAI account per token",
        "how": "set OPENAI_API_KEY",
    },
}


def _provider_client(provider: str) -> OpenAI | None:
    """Return the client for a provider.

    Reads the module attribute at call time so tests can monkeypatch
    either client independently.
    """
    if provider == "groq":
        return _groq_client
    if provider == "local":
        return _local_client
    return _openai_client


def _provider_base_url(provider: str) -> str | None:
    """Base URL used for a provider's OpenAI-compatible API."""
    if provider == "groq":
        return GROQ_BASE_URL
    if provider == "local":
        return LOCAL_LLM_BASE_URL
    # OpenAI — use the SDK default endpoint.
    return None


def _is_provider_available(provider: str) -> bool:
    """Whether a provider is configured well enough to answer a question.

    Purely local: it inspects configuration and never makes a network call, so
    it is safe to call while building a model list for the UI.
    """
    if provider == "local":
        return _local_client is not None
    return _provider_client(provider) is not None


def is_model_available(model_id: str) -> bool:
    """Whether a specific model can be used right now."""
    entry = _MODEL_BY_ID.get(model_id)
    return bool(entry) and _is_provider_available(entry["provider"])


def _providers_free_first() -> list[str]:
    """Provider names, cheapest first, registry order within a tier.

    Derived from the registry so the message cannot disagree with the tiers the
    Settings picker shows: a provider labelled free there is offered first here.
    Sorting is stable, so registry order survives inside each group.
    """
    may_bill: dict[str, bool] = {}
    for entry in MODEL_REGISTRY:
        provider = entry["provider"]
        # A provider is free only while *every* model it offers is free; one
        # paid model makes it something that can cost money.
        may_bill[provider] = may_bill.get(provider, True) and entry["tier"] != "free"
    return sorted(
        (provider for provider in may_bill if provider in _PROVIDER_SETUP),
        key=may_bill.get,
    )


def unconfigured_provider_hint(provider: str) -> str:
    """The hint shown when a question cannot be answered for lack of a provider.

    Two different situations share one code path, and conflating them is what
    made the old message unhelpful:

    - **Nothing is configured at all.** The reader cannot answer anything, so
      every option is listed, cheapest first, each labelled with its cost. The
      paid one is named too, but last and marked as paid.
    - **Some other provider is configured**, just not the one this model needs.
      Then only that provider's variable is named — listing the rest would
      wrongly suggest they are all unavailable — plus a pointer to the models
      that do work right now.

    Availability is a local inspection of configuration (see
    ``_is_provider_available``); nothing here probes a provider over the
    network, so this stays safe to render.
    """
    setup = _PROVIDER_SETUP.get(provider) or _PROVIDER_SETUP["openai"]

    if any(_is_provider_available(name) for name in _PROVIDER_SETUP):
        return (
            f"{UNCONFIGURED_PREFIX} To use {setup['name']} models "
            f"({setup['cost']}), {setup['how']}. Or pick one of the models "
            "that are already available in Settings."
        )

    options = "\n".join(
        f"- {_PROVIDER_SETUP[name]['name']} ({_PROVIDER_SETUP[name]['cost']}): "
        f"{_PROVIDER_SETUP[name]['how']}"
        for name in _providers_free_first()
    )
    return f"{UNCONFIGURED_PREFIX} No provider is set up yet. Enable any one:\n{options}"


def resolve_default_model() -> str:
    """Pick the model to use when a request does not name one.

    Free-first, and never silently paid. The order is deliberate:

    1. ``QA_MODEL`` — the operator naming a model is an explicit choice and is
       honoured even when it is a paid one.
    2. A free model that is actually configured. Groq is preferred over the
       local server because it is a hosted model that answers better; the local
       one is a CPU-only last resort, not something to default every user onto.
    3. ``OPENAI_MODEL`` — a paid model, reached only when nothing free exists.
       This is the step that used to be the *default*, which meant a user who
       had set a free Groq key was still routed to a paid model unless every
       single request overrode it.
    """
    configured = os.getenv("QA_MODEL", "").strip()
    if configured and configured in _MODEL_BY_ID:
        return configured

    for entry in MODEL_REGISTRY:
        if entry["tier"] == "free" and _is_provider_available(entry["provider"]):
            return entry["id"]

    # Nothing free is configured, so a paid model is the only option left. The
    # cheapest one is a better default than OPENAI_MODEL: the old default was
    # `gpt-4`, which is several times the price of `gpt-4o-mini` for a default
    # the user never chose. An explicitly configured OPENAI_MODEL still wins --
    # read live from the environment rather than from the import-time constant,
    # so the value that was checked is the value that is returned.
    explicit_openai_model = os.getenv("OPENAI_MODEL", "").strip()
    # Registry-checked, like QA_MODEL above: a value that names no known model
    # is a typo or a model that has since been retired, and honouring it would
    # route every question to a model id the service cannot call. Falling
    # through to the paid-model loop below keeps the deployment answering
    # questions with the cheapest model that does exist.
    if explicit_openai_model and explicit_openai_model in _MODEL_BY_ID:
        return explicit_openai_model
    for entry in MODEL_REGISTRY:
        if entry["tier"] == "paid" and _is_provider_available(entry["provider"]):
            return entry["id"]

    return OPENAI_MODEL


def _client_for_model(model_id: str) -> tuple[OpenAI | None, str]:
    """Resolve a model id to its provider client + provider name.

    Never raises. An id that is in neither the request nor the registry — a
    stale model name, or an operator whose ``OPENAI_MODEL`` names a model this
    build does not know — resolves to no client instead of a ``KeyError``, so
    the caller returns the graceful "provider not configured" answer rather
    than a 500. A model that cannot be resolved is a configuration problem to
    report to the operator, not a request to crash on.
    """
    entry = _MODEL_BY_ID.get(model_id) or _MODEL_BY_ID.get(OPENAI_MODEL)
    if entry is None:
        return None, "openai"
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
        effective_model = model or resolve_default_model()

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
            # Retrieval quality bounds answer quality: in keyword-only mode the
            # model is reasoning over passages literal matching happened to
            # find, so the answer is degraded for the same reason the results
            # are. Reported here rather than left for the user to infer.
            mode=search_response.mode,
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
        """Available QA models, split by tier and annotated with availability.

        The split alone is not enough for a UI: every model in the registry
        exists whether or not it is configured, so the picker would happily
        offer a model that can only answer "AI service is not configured".
        Each entry therefore carries whether it can be used right now, and
        ``default`` is the model a request without one would actually use.
        """
        return {
            "free": FREE_MODELS,
            "paid": [m for m in AVAILABLE_MODELS if m not in FREE_MODELS],
            "default": resolve_default_model(),
            "models": [
                {
                    "id": entry["id"],
                    "label": entry["label"],
                    "provider": entry["provider"],
                    "tier": entry["tier"],
                    "available": _is_provider_available(entry["provider"]),
                }
                for entry in MODEL_REGISTRY
            ],
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
        effective_model = model or resolve_default_model()
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
            return unconfigured_provider_hint(provider)

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