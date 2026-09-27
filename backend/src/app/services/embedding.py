import os
import time

from openai import (
    APIConnectionError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

from app.env import drop_blank_provider_vars

# Before anything below reads the environment or builds a client: the sandbox
# passes OPENAI_BASE_URL through Compose as "" when unset, and the SDK would
# take that as a real base URL. Idempotent, so the qa service's own call is
# harmless.
drop_blank_provider_vars()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-ada-002")

# Explicit per-request timeout so a hung embeddings call cannot stall the
# document pipeline indefinitely (the OpenAI SDK default is 10 minutes).
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


def _build_client() -> OpenAI | None:
    """Create the shared OpenAI client with an explicit request timeout."""
    if not OPENAI_API_KEY:
        return None
    return OpenAI(api_key=OPENAI_API_KEY, timeout=EMBEDDING_TIMEOUT_SECONDS)


client = _build_client()


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
    def generate_embedding(self, text: str) -> list[float]:
        if client is None:
            raise RuntimeError(
                "OpenAI client not configured. Set OPENAI_API_KEY."
            )

        response = _create_with_retry(
            client,
            model=EMBEDDING_MODEL,
            input=text,
        )

        return response.data[0].embedding

    def generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        if client is None:
            raise RuntimeError(
                "OpenAI client not configured. Set OPENAI_API_KEY."
            )

        embeddings: list[list[float]] = []
        for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
            batch = texts[start : start + EMBEDDING_BATCH_SIZE]
            response = _create_with_retry(
                client,
                model=EMBEDDING_MODEL,
                input=batch,
            )
            embeddings.extend(item.embedding for item in response.data)
        return embeddings
