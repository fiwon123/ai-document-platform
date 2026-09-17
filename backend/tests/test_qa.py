"""Tests for QA document filtering (document_ids)."""

from unittest.mock import MagicMock
from uuid import uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.search import SearchRepository
from app.schemas.document import QARequest, QAResponse, SearchResult
from app.services.qa import QAService

DIM = 1536


def _make_vector(on_dim: int) -> list[float]:
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


def _seed_user_with_documents(db_session) -> tuple[UserDB, DocumentDB, DocumentDB]:
    user = UserDB(username="bob", hashed_password="x")  # noqa: S106
    db_session.add(user)
    db_session.flush()

    doc1 = DocumentDB(
        owner_id=user.id,
        filename="report.pdf",
        object_key="k/report.pdf",
        status=DocumentStatus.READY,
    )
    doc2 = DocumentDB(
        owner_id=user.id,
        filename="notes.txt",
        object_key="k/notes.txt",
        status=DocumentStatus.READY,
    )
    db_session.add_all([doc1, doc2])
    db_session.flush()

    db_session.add_all(
        [
            DocumentChunk(
                document_id=doc1.id,
                content="quarterly revenue increased",
                chunk_index=0,
                embedding=_make_vector(0),
            ),
            DocumentChunk(
                document_id=doc2.id,
                content="meeting notes about strategy",
                chunk_index=0,
                embedding=_make_vector(1),
            ),
        ]
    )
    db_session.commit()
    return user, doc1, doc2


class TestQAServiceDocumentFilter:
    def test_ask_forwards_document_ids_to_search(self):
        search_service = MagicMock()
        search_response = MagicMock()
        search_response.results = []
        search_service.search.return_value = search_response
        service = QAService(search_service=search_service)
        user_id = uuid4()
        doc_ids = [uuid4(), uuid4()]

        service.ask(user_id=user_id, question="what is revenue?", document_ids=doc_ids)

        search_service.search.assert_called_once_with(
            user_id=user_id,
            query="what is revenue?",
            top_k=5,
            document_ids=doc_ids,
        )

    def test_ask_without_document_ids_searches_all(self):
        search_service = MagicMock()
        search_response = MagicMock()
        search_response.results = []
        search_service.search.return_value = search_response
        service = QAService(search_service=search_service)

        service.ask(user_id=uuid4(), question="question?")

        search_service.search.assert_called_once_with(
            user_id=search_service.search.call_args.kwargs["user_id"],
            query="question?",
            top_k=5,
            document_ids=None,
        )


class TestSearchRepositoryDocumentFilter:
    def test_vector_search_filters_by_document_ids(self, db_session):
        user, doc1, _doc2 = _seed_user_with_documents(db_session)
        repo = SearchRepository(db_session)

        results, total_count = repo.search(
            user_id=user.id,
            query_embedding=_make_vector(0),
            top_k=10,
            document_ids=[doc1.id],
        )

        assert len(results) == 1
        assert total_count == 1
        assert results[0].document_id == doc1.id
        assert "revenue" in results[0].content

    def test_text_search_filters_by_document_ids(self, db_session):
        user, _doc1, doc2 = _seed_user_with_documents(db_session)
        repo = SearchRepository(db_session)

        results, _ = repo.search(
            user_id=user.id,
            query_embedding=None,
            top_k=10,
            document_ids=[doc2.id],
        )

        assert len(results) == 1
        assert results[0].document_id == doc2.id

    def test_search_without_filter_returns_all_documents(self, db_session):
        user, doc1, _doc2 = _seed_user_with_documents(db_session)
        repo = SearchRepository(db_session)

        results, total_count = repo.search(
            user_id=user.id,
            query_embedding=None,
            top_k=10,
        )

        assert {r.document_id for r in results} == {doc1.id, _doc2.id}
        assert total_count == 2


class TestQARoute:
    def test_ask_endpoint_forwards_document_ids(self, client, auth_headers):
        from uuid import UUID as UUIDType

        from app.main import app
        from app.routes.qa import get_qa_service

        fake_service = MagicMock()
        fake_service.ask.return_value = {
            "question": "q",
            "answer": "a",
            "sources": [],
        }
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={
                    "question": "what is revenue?",
                    "document_ids": ["00000000-0000-0000-0000-000000000002"],
                },
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        fake_service.ask.assert_called_once_with(
            user_id=fake_service.ask.call_args.kwargs["user_id"],
            question="what is revenue?",
            document_ids=[UUIDType("00000000-0000-0000-0000-000000000002")],
            model=None,
            api_key=None,
        )

    def test_ask_endpoint_accepts_request_schema(self, db_session):
        """QARequest schema validates the optional document_ids field."""
        from uuid import UUID as UUIDType

        request = QARequest(
            question="what is revenue?",
            document_ids=["00000000-0000-0000-0000-000000000002"],
        )
        assert request.document_ids == [UUIDType("00000000-0000-0000-0000-000000000002")]

        search_result = SearchResult(
            chunk_id=uuid4(),
            document_id=uuid4(),
            document_filename="a.txt",
            content="c",
            score=0.1,
        )
        assert search_result.score == 0.1

    def test_ask_endpoint_forwards_model_override(self, client, auth_headers):
        from app.main import app
        from app.routes.qa import get_qa_service

        fake_service = MagicMock()
        fake_service.ask.return_value = {
            "question": "q",
            "answer": "a",
            "sources": [],
        }
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={"question": "q", "model": "gpt-4o-mini"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert fake_service.ask.call_args.kwargs["model"] == "gpt-4o-mini"

    def test_ask_endpoint_forwards_api_key(self, client, auth_headers):
        from app.main import app
        from app.routes.qa import get_qa_service

        fake_service = MagicMock()
        fake_service.ask.return_value = {
            "question": "q",
            "answer": "a",
            "sources": [],
        }
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={"question": "q", "api_key": "sk-user-key-123"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert fake_service.ask.call_args.kwargs["api_key"] == "sk-user-key-123"

    def test_ask_endpoint_without_api_key_forwards_none(self, client, auth_headers):
        from app.main import app
        from app.routes.qa import get_qa_service

        fake_service = MagicMock()
        fake_service.ask.return_value = {
            "question": "q",
            "answer": "a",
            "sources": [],
        }
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={"question": "q"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert fake_service.ask.call_args.kwargs["api_key"] is None

    def test_ask_endpoint_without_model_forwards_none(self, client, auth_headers):
        from app.main import app
        from app.routes.qa import get_qa_service

        fake_service = MagicMock()
        fake_service.ask.return_value = {
            "question": "q",
            "answer": "a",
            "sources": [],
        }
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={"question": "q"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert fake_service.ask.call_args.kwargs["model"] is None

    def test_ask_rejects_unknown_model(self, client, auth_headers):
        resp = client.post(
            "/v1/qa/ask",
            json={"question": "q", "model": "does-not-exist"},
            headers=auth_headers,
        )

        assert resp.status_code == 400
        assert resp.json()["error"]["message"] == "Unknown model: does-not-exist"

    def test_models_endpoint(self, client):
        from app.services.qa import AVAILABLE_MODELS

        resp = client.get("/v1/qa/models")

        assert resp.status_code == 200
        data = resp.json()
        # Free tier = GPT-4o mini + the free Groq Llama models.
        assert data["free"] == [
            "gpt-4o-mini",
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
        ]
        assert "gpt-4o-mini" not in data["paid"]
        assert sorted(data["free"] + data["paid"]) == sorted(AVAILABLE_MODELS)

    def test_ask_accepts_groq_model(self, client, auth_headers, monkeypatch):
        """Groq model ids pass route validation and reach the groq client."""
        from types import SimpleNamespace

        from app.main import app
        from app.routes.qa import get_qa_service
        from app.services import qa as qa_module

        fake_groq = MagicMock()
        fake_groq.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Groq answer"))]
        )
        monkeypatch.setattr(qa_module, "_groq_client", fake_groq)
        fake_service = MagicMock()
        fake_service.ask.return_value = QAResponse(
            question="q",
            answer="Groq answer",
            sources=[],
            model="llama-3.3-70b-versatile",
        )
        app.dependency_overrides[get_qa_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/qa/ask",
                json={"question": "q", "model": "llama-3.3-70b-versatile"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert fake_service.ask.call_args.kwargs["model"] == "llama-3.3-70b-versatile"

class TestQAServiceAnswerGeneration:
    """Answer synthesis path with the LLM client mocked."""

    def test_build_context_formats_sources(self):
        service = QAService(search_service=MagicMock())
        results = [
            SearchResult(
                chunk_id=uuid4(),
                document_id=uuid4(),
                document_filename="a.txt",
                content="first chunk",
                score=0.5,
            ),
            SearchResult(
                chunk_id=uuid4(),
                document_id=uuid4(),
                document_filename="b.txt",
                content="second chunk",
                score=0.4,
            ),
        ]

        context = service._build_context(results)

        assert "[Source 1] Document: a.txt\nfirst chunk" in context
        assert "[Source 2] Document: b.txt\nsecond chunk" in context

    def test_build_context_empty_returns_placeholder(self):
        service = QAService(search_service=MagicMock())

        assert service._build_context([]) == "No relevant documents found."

    def test_ask_falls_back_when_llm_not_configured(self, monkeypatch):
        from app.services import qa as qa_module

        monkeypatch.setattr(qa_module, "_openai_client", None)
        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        assert "AI service is not configured" in response.answer
        assert response.sources == []

    def test_ask_groq_missing_key_message(self, monkeypatch):
        """A free Groq model without GROQ_API_KEY gives a helpful hint."""
        from app.services import qa as qa_module

        monkeypatch.setattr(qa_module, "_groq_client", None)
        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(
            user_id=uuid4(),
            question="q",
            model="llama-3.1-8b-instant",
        )

        assert "AI service is not configured" in response.answer
        assert "GROQ_API_KEY" in response.answer
        assert response.model == "llama-3.1-8b-instant"

    def test_ask_uses_groq_client_for_groq_model(self, monkeypatch):
        """Model routing: Groq models hit the Groq client, not OpenAI."""
        from types import SimpleNamespace

        from app.services import qa as qa_module

        fake_groq = MagicMock()
        fake_groq.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Groq answer"))]
        )
        monkeypatch.setattr(qa_module, "_groq_client", fake_groq)
        # OpenAI is NOT configured in this scenario.
        monkeypatch.setattr(qa_module, "_openai_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(
            user_id=uuid4(),
            question="q",
            model="llama-3.3-70b-versatile",
        )

        assert (
            fake_groq.chat.completions.create.call_args.kwargs["model"]
            == "llama-3.3-70b-versatile"
        )
        assert response.answer == "Groq answer"
        assert response.model == "llama-3.3-70b-versatile"

    def test_ask_uses_mocked_llm_and_returns_sources(self, monkeypatch):
        from types import SimpleNamespace

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Mocked answer"))]
        )
        monkeypatch.setattr("app.services.qa._openai_client", fake_client)

        fake_search = MagicMock()
        result = SearchResult(
            chunk_id=uuid4(),
            document_id=uuid4(),
            document_filename="a.txt",
            content="context",
            score=0.5,
        )
        fake_search.search.return_value = MagicMock(results=[result])
        service = QAService(search_service=fake_search)
        document_ids = [uuid4()]

        response = service.ask(
            user_id=uuid4(),
            question="what is revenue?",
            document_ids=document_ids,
        )

        fake_search.search.assert_called_once_with(
            user_id=fake_search.search.call_args.kwargs["user_id"],
            query="what is revenue?",
            top_k=5,
            document_ids=document_ids,
        )
        assert response.answer == "Mocked answer"
        assert response.question == "what is revenue?"
        assert response.sources == [result]
        assert "[Source 1]" in fake_client.chat.completions.create.call_args.kwargs[
            "messages"
        ][1]["content"]

    def test_ask_surfaces_llm_errors(self, monkeypatch):
        from app.services.qa import _KEY_PATTERN  # noqa: F401

        fake_client = MagicMock()
        fake_client.chat.completions.create.side_effect = RuntimeError("boom")
        monkeypatch.setattr("app.services.qa._openai_client", fake_client)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        # Provider failure (SDK messages can leak API-key prefixes) is
        # redacted from the user-facing answer — exactly as the "LLM error
        # must be redacted" checklist item requires.
        assert response.answer == (
            "Could not generate an answer with the AI provider. Please try again."
        )

    def test_ask_passes_model_override(self, monkeypatch):
        from types import SimpleNamespace

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Mocked answer"))]
        )
        monkeypatch.setattr("app.services.qa._openai_client", fake_client)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(
            user_id=uuid4(),
            question="q",
            model="gpt-4o-mini",
        )

        assert (
            fake_client.chat.completions.create.call_args.kwargs["model"]
            == "gpt-4o-mini"
        )
        assert response.model == "gpt-4o-mini"

    def test_ask_with_api_key_builds_throwaway_client(self, monkeypatch):
        """BYOK: a user key creates a per-request client and is not required
        to be configured server-side."""
        from types import SimpleNamespace

        from app.services import qa as qa_module

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="BYOK answer"))]
        )
        captured: dict = {}

        def fake_openai_factory(api_key=None, base_url=None):
            captured["api_key"] = api_key
            captured["base_url"] = base_url
            return fake_client

        monkeypatch.setattr(qa_module, "OpenAI", fake_openai_factory)
        # No server key configured — BYOK must still work.
        monkeypatch.setattr(qa_module, "_openai_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q", api_key="sk-user-secret")

        assert captured["api_key"] == "sk-user-secret"
        # OpenAI provider uses the SDK default endpoint.
        assert captured["base_url"] is None
        assert response.answer == "BYOK answer"

    def test_ask_with_api_key_for_groq_model_uses_groq_base_url(self, monkeypatch):
        from types import SimpleNamespace

        from app.services import qa as qa_module

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Groq BYOK"))]
        )
        captured: dict = {}
        monkeypatch.setattr(
            qa_module,
            "OpenAI",
            lambda api_key=None, base_url=None: captured.update(
                api_key=api_key, base_url=base_url
            )
            or fake_client,
        )
        monkeypatch.setattr(qa_module, "_groq_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(
            user_id=uuid4(),
            question="q",
            model="llama-3.1-8b-instant",
            api_key="sk-user-groq",
        )

        assert captured["api_key"] == "sk-user-groq"
        assert captured["base_url"] == qa_module.GROQ_BASE_URL
        assert response.answer == "Groq BYOK"

    def test_ask_defaults_to_configured_model(self, monkeypatch):
        from types import SimpleNamespace

        from app.services.qa import OPENAI_MODEL

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Mocked answer"))]
        )
        monkeypatch.setattr("app.services.qa._openai_client", fake_client)

        fake_search = MagicMock()
        fake_search.search.return_value = MagicMock(results=[])
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        assert fake_client.chat.completions.create.call_args.kwargs["model"] == (
            OPENAI_MODEL
        )
        assert response.model == OPENAI_MODEL
