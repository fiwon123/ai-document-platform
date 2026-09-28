"""Embedding providers: hosted OpenAI, or a keyless local OpenAI-compatible server.

Two spaces, and the choice between them is deliberately not "newest wins":

* With ``OPENAI_API_KEY`` the OpenAI space is used, exactly as before. A
  deployment that has always embedded with OpenAI keeps embedding with OpenAI
  even if the operator also runs Ollama for chat — switching it silently would
  invalidate every vector it owns, and nothing would say so.
* Without it, and with ``LOCAL_LLM_ENABLED``, the local space is used. This is
  the case the local provider exists for: a zero-cost deployment whose
  semantic search currently degrades to keyword matching.
* With neither, no client is built and the service reports itself
  unconfigured, which is what puts search into its documented ``keyword`` mode.

The one thing this module will not do is store a vector of the wrong width. A
local embedding model is 768, 1024 or 384 wide depending on its name, the
column cannot reject it, and a column holding two widths makes the *search
query* fail rather than the insert. So every vector is checked against the
configured width here, on the way out, before it can be written or queried.
"""

import logging
import os
import time
from dataclasses import dataclass

from openai import (
    APIConnectionError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

from app.env import drop_blank_provider_vars
from app.local_provider import (
    LOCAL_LLM_BASE_URL,
    LOCAL_LLM_ENABLED,
    LOCAL_PLACEHOLDER_KEY,
)
from app.models.chunk import (
    LOCAL_EMBEDDING_SPACE,
    OPENAI_EMBEDDING_SPACE,
)

# Before anything below reads the environment or builds a client: the sandbox
# passes OPENAI_BASE_URL through Compose as "" when unset, and the SDK would
# take that as a real base URL. Idempotent, so the qa service's own call is
# harmless.
drop_blank_provider_vars()

logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Explicit per-request timeout so a hung embeddings call cannot stall the
# document pipeline indefinitely (the OpenAI SDK default is 10 minutes). Local
# CPU inference is slower still, so the same ceiling applies to both; a
# document that cannot be embedded inside it is saved without vectors and stays
# keyword-searchable.
EMBEDDING_TIMEOUT_SECONDS = int(os.getenv("EMBEDDING_TIMEOUT_SECONDS", "120"))

# The embeddings API accepts a bounded number of texts per request; batch
# large documents so every chunk still gets a vector (order preserved).
EMBEDDING_BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "2048"))

# Transient embedding-API failures (timeouts, connection resets, rate
# limits, 5xx) are retried with exponential backoff so that a single API
# blip does not silently degrade a whole document to text-only search.
# Client-side errors (400/401/422...) are never retried. The worker's
# existing try/except remains the last resort: if all attempts fail, the
# document is still saved without vectors.
EMBEDDING_RETRY_ATTEMPTS = int(os.getenv("EMBEDDING_RETRY_ATTEMPTS", "2"))
EMBEDDING_RETRY_BACKOFF_SECONDS = float(
    os.getenv("EMBEDDING_RETRY_BACKOFF_SECONDS", "1.0")
)

# APITimeoutError subclasses APIConnectionError in the OpenAI SDK, so the
# tuple covers timeouts, connection resets, 429s and internal errors.
_RETRYABLE_EXCEPTIONS = (
    APIConnectionError,
    RateLimitError,
    InternalServerError,
)


def _positive_int_env(name: str, default: int) -> int:
    """Read a positive integer setting, falling back rather than crashing.

    Blank-safe for the same reason every other read in this codebase is: the
    sandbox passes "" for an unset variable, and an unguarded ``int("")`` here
    would be an ``ImportError`` in *every* process — the API and the worker —
    rather than a failed embeddings call. Malformed and non-positive values
    warn and fall back, because a width of 0 or -1 has no meaning at all and
    would produce a check that always fires.
    """
    raw = (os.getenv(name, "") or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning(
            "%s=%r is not a whole number; using %d", name, raw, default
        )
        return default
    if value < 1:
        logger.warning("%s=%d is below 1; using %d", name, value, default)
        return default
    return value


@dataclass(frozen=True)
class EmbeddingSpaceConfig:
    """How to ask one provider for vectors, and how wide they must be."""

    space: str
    model: str
    dimensions: int


# The OpenAI space. `EMBEDDING_DIMENSIONS` is the width of
# `text-embedding-ada-002`; naming it is what lets the width check below be
# about *this* model rather than a hardcoded constant, so a deliberate switch
# to another 1536-wide model is a config change and not a silent one.
EMBEDDING_MODEL = (os.getenv("EMBEDDING_MODEL", "") or "").strip() or (
    "text-embedding-ada-002"
)
OPENAI_SPACE_CONFIG = EmbeddingSpaceConfig(
    space=OPENAI_EMBEDDING_SPACE,
    model=EMBEDDING_MODEL,
    dimensions=_positive_int_env("EMBEDDING_DIMENSIONS", 1536),
)

# The local space. `nomic-embed-text` is Ollama's best-supported embedding
# model and is 768-wide; an operator naming a different one must state its
# width too, which the check below will then hold them to.
LOCAL_EMBEDDING_MODEL = (os.getenv("LOCAL_EMBEDDING_MODEL", "") or "").strip() or (
    "nomic-embed-text"
)
LOCAL_SPACE_CONFIG = EmbeddingSpaceConfig(
    space=LOCAL_EMBEDDING_SPACE,
    model=LOCAL_EMBEDDING_MODEL,
    dimensions=_positive_int_env("LOCAL_EMBEDDING_DIMENSIONS", 768),
)

SPACE_CONFIGS = {
    config.space: config
    for config in (OPENAI_SPACE_CONFIG, LOCAL_SPACE_CONFIG)
}


class EmbeddingDimensionMismatch(RuntimeError):
    """A provider returned a vector that is not the configured width.

    A configuration problem, not a transient one: the operator named one model
    and configured the width of another. Retrying cannot fix it, so it is not
    retried, and the message names both widths and both models because the
    whole fix is in that sentence.
    """


def _check_dimensions(vector: list[float], config: EmbeddingSpaceConfig) -> None:
    width = len(vector)
    if width == config.dimensions:
        return
    raise EmbeddingDimensionMismatch(
        f"{config.model} returned a {width}-dimension embedding but "
        f"{width} was not the configured width for that model "
        f"({config.dimensions}). Vectors of different widths cannot be "
        f"compared, so nothing was written. Set the width of {config.model} to "
        f"{width}, or set the model to one that is {config.dimensions}-wide."
    )


def _resolve_active_space() -> str | None:
    """Which space new vectors go into; None when no provider is configured.

    OpenAI first, deliberately. See the module docstring: a deployment with an
    OpenAI key has vectors in the OpenAI space today, and moving it to a local
    model because the operator also runs Ollama for chat would silently strand
    them.
    """
    if OPENAI_API_KEY:
        return OPENAI_EMBEDDING_SPACE
    if LOCAL_LLM_ENABLED:
        return LOCAL_EMBEDDING_SPACE
    return None


ACTIVE_SPACE = _resolve_active_space()


def _build_client(space: str) -> OpenAI | None:
    """Build the client for one space, with an explicit request timeout.

    Returns None when that space is not configured. The local client is built
    from a placeholder key because the OpenAI SDK refuses to build one without
    a key even when the endpoint ignores it — the same reason the QA service
    does this.
    """
    if space == OPENAI_EMBEDDING_SPACE:
        if not OPENAI_API_KEY:
            return None
        return OpenAI(api_key=OPENAI_API_KEY, timeout=EMBEDDING_TIMEOUT_SECONDS)
    if not LOCAL_LLM_ENABLED:
        return None
    return OpenAI(
        api_key=LOCAL_PLACEHOLDER_KEY,
        base_url=LOCAL_LLM_BASE_URL,
        timeout=EMBEDDING_TIMEOUT_SECONDS,
    )


# Kept as two module attributes, mirroring the QA service, so a test can
# disable one provider without touching the other and `_space_client` can read
# the attribute at call time.
_openai_client = _build_client(OPENAI_EMBEDDING_SPACE)
_local_client = _build_client(LOCAL_EMBEDDING_SPACE)


def _space_client(space: str | None) -> OpenAI | None:
    """The client for a space, read at call time so tests can patch it."""
    if space == OPENAI_EMBEDDING_SPACE:
        return _openai_client
    if space == LOCAL_EMBEDDING_SPACE:
        return _local_client
    return None


def _create_with_retry(client, *, model, input):
    """Call ``client.embeddings.create`` with bounded retries on blips."""
    for attempt in range(EMBEDDING_RETRY_ATTEMPTS + 1):
        try:
            return client.embeddings.create(model=model, input=input)
        except _RETRYABLE_EXCEPTIONS:
            if attempt >= EMBEDDING_RETRY_ATTEMPTS:
                raise
            # Exponential backoff: base, base*2, base*4, ...
            delay = EMBEDDING_RETRY_BACKOFF_SECONDS * (2**attempt)
            time.sleep(delay)
    raise RuntimeError("unreachable")


class EmbeddingService:
    """Generate vectors for the active embedding space.

    ``space`` and ``model`` describe the vectors this service produces, and the
    worker and the search service both read them: a vector is only comparable
    with vectors from the same model, so the writer and the reader of a column
    have to agree on which model that is.
    """

    @property
    def space(self) -> str | None:
        """The active embedding space, or None when no provider is set up."""
        return ACTIVE_SPACE

    @property
    def config(self) -> EmbeddingSpaceConfig | None:
        """Model and width for the active space."""
        return SPACE_CONFIGS.get(ACTIVE_SPACE) if ACTIVE_SPACE else None

    @property
    def model(self) -> str | None:
        """The model new vectors are attributed to, or None when unconfigured."""
        config = self.config
        return config.model if config else None

    def _require_client(self) -> tuple[OpenAI, EmbeddingSpaceConfig]:
        """The active client + config, or an explanation of why there is none.

        Raises rather than returning an empty vector: the caller's own
        try/except is what degrades a document to keyword-searchable, and a
        silent empty result would instead write a chunk with no vector and no
        reason anywhere.
        """
        if ACTIVE_SPACE is None:
            raise RuntimeError(
                "No embedding provider is configured, so documents can only be "
                "searched by keyword. Set OPENAI_API_KEY for OpenAI "
                "embeddings, or set LOCAL_LLM_ENABLED=true (with "
                f"LOCAL_EMBEDDING_MODEL, defaulting to "
                f"{LOCAL_SPACE_CONFIG.model}) to use a local model server."
            )
        client = _space_client(ACTIVE_SPACE)
        if client is None:
            raise RuntimeError(
                f"The {ACTIVE_SPACE} embedding provider is selected but has no "
                "client. This is a configuration problem, not a network one."
            )
        return client, SPACE_CONFIGS[ACTIVE_SPACE]

    def generate_embedding(self, text: str) -> list[float]:
        client, config = self._require_client()
        response = _create_with_retry(
            client,
            model=config.model,
            input=text,
        )
        vector = response.data[0].embedding
        _check_dimensions(vector, config)
        return vector

    def generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        client, config = self._require_client()

        embeddings: list[list[float]] = []
        for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
            batch = texts[start : start + EMBEDDING_BATCH_SIZE]
            response = _create_with_retry(
                client,
                model=config.model,
                input=batch,
            )
            for item in response.data:
                _check_dimensions(item.embedding, config)
                embeddings.append(item.embedding)
        return embeddings
