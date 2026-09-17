import os

from openai import OpenAI

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-ada-002")

client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None


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

        response = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=texts,
        )

        return [item.embedding for item in response.data]
