import os
from uuid import UUID

from openai import OpenAI

from app.schemas.document import QARequest, QAResponse, SearchResult
from app.services.search import SearchService

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4")

AVAILABLE_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-turbo"]
FREE_MODELS = ["gpt-4o-mini"]

client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None


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
        if client is None:
            return (
                "AI service is not configured. Please set the OPENAI_API_KEY "
                "environment variable to enable AI-powered answers."
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
                model=model or OPENAI_MODEL,
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
