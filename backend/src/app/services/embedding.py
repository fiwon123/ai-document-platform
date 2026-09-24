import os

from openai import OpenAI

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-ada-002")

# Explicit per-request timeout so a hung embeddings call cannot stall the
# document pipeline indefinitely (the OpenAI SDK default is 10 minutes).
EMBEDDING_TIMEOUT_SECONDS = int(os.getenv("EMBEDDING_TIMEOUT_SECONDS", "120"))

# The embeddings API accepts a bounded number of texts per request; batch
# large documents so every chunk still gets a vector (order preserved).
EMBEDDING_BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "2048"))


def _build_client() -> OpenAI | None:
    """Create the shared OpenAI client with an explicit request timeout."""
    if not OPENAI_API_KEY:
        return None
    return OpenAI(api_key=OPENAI_API_KEY, timeout=EMBEDDING_TIMEOUT_SECONDS)


client = _build_client()


class EmbeddingService:
    def generate_embedding(self, text: str) -> list[float]:
        if client is None:
            raise RuntimeError(
                "OpenAI client not configured. Set OPENAI_API_KEY."
            )

        response = client.embeddings.create(
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
            response = client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=batch,
            )
            embeddings.extend(item.embedding for item in response.data)
        return embeddings
