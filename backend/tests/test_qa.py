"""Tests for QA document filtering (document_ids)."""

from contextlib import contextmanager
from unittest.mock import MagicMock
from uuid import uuid4

import httpx

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.search import SearchRepository
from app.schemas.qa import QARequest, QAResponse
from app.schemas.search import SearchMode, SearchResponse, SearchResult
from app.services.qa import LOCAL_LLM_MODEL, QAService

DIM = 1536


def qa_entry(model_id):
    """The registry entry for a model id."""
    from app.services import qa as qa_module

    return qa_module._MODEL_BY_ID[model_id]


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
        search_response = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        search_response = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
            query_text="strategy",
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
            # Matches one term in each document, so the unfiltered case can
            # still be observed now that keyword search filters at all.
            query_text="quarterly strategy",
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
        # Free means usable without paying: the Groq models and the local one.
        # gpt-4o-mini is deliberately NOT here -- it is cheap, but it bills an
        # OpenAI account, and a "free" list containing it misleads.
        assert data["free"] == [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            LOCAL_LLM_MODEL,
        ]
        assert "gpt-4o-mini" in data["paid"]
        assert sorted(data["free"] + data["paid"]) == sorted(AVAILABLE_MODELS)

        # The tier split alone is not enough for a picker: every registered model
        # exists whether or not it is configured.
        by_id = {m["id"]: m for m in data["models"]}
        assert set(by_id) == set(AVAILABLE_MODELS)
        assert by_id["gpt-4"]["provider"] == "openai"
        assert by_id["gpt-4"]["tier"] == "paid"
        assert by_id["llama-3.3-70b-versatile"]["provider"] == "groq"
        assert by_id[LOCAL_LLM_MODEL]["provider"] == "local"
        assert "default" in data

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

        # Every provider, not just OpenAI: the hint now distinguishes "nothing
        # is configured" from "this model needs a provider you have not set up",
        # so the test has to say which of the two it is exercising rather than
        # inherit it from whatever keys happen to exist in the environment.
        for attr in ("_openai_client", "_groq_client", "_local_client"):
            monkeypatch.setattr(qa_module, attr, None)
        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        assert "AI service is not configured" in response.answer
        assert response.sources == []

    def test_ask_groq_missing_key_message(self, monkeypatch):
        """A free Groq model without GROQ_API_KEY gives a helpful hint."""
        from app.services import qa as qa_module

        for attr in ("_openai_client", "_groq_client", "_local_client"):
            monkeypatch.setattr(qa_module, attr, None)
        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[result], total_count=1, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
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

    def test_ask_defaults_to_a_free_model_not_the_paid_one(self, monkeypatch):
        """The default must not be a paid model when a free one is configured.

        This is the whole point of the change: the default used to be
        OPENAI_MODEL, so a user who had configured only a free Groq key was
        still routed to a paid OpenAI model on every request that did not
        override it.
        """
        from types import SimpleNamespace

        from app.services import qa as qa_module

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Mocked answer"))]
        )
        monkeypatch.setattr(qa_module, "_openai_client", fake_client)
        # A free model is configured, and the paid one is available too.
        monkeypatch.setattr(qa_module, "_groq_client", fake_client)
        monkeypatch.setattr(qa_module, "_local_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        entry = qa_module._MODEL_BY_ID[response.model]
        assert entry["tier"] == "free", (
            f"defaulted to the paid model {response.model!r} while a free one "
            "was configured"
        )
        assert response.model == "llama-3.3-70b-versatile"


class TestDefaultModelResolution:
    """Free-first resolution, and never a silently paid model.

    Every case pins a *different* configuration, because the ordering is the
    feature: a change that merely flipped a constant would pass a test that
    only checked "the default is not gpt-4".
    """

    @staticmethod
    def _configure(monkeypatch, *, openai=True, groq=False, local=False, qa_model=""):
        from app.services import qa as qa_module

        sentinel = MagicMock()
        monkeypatch.setattr(qa_module, "_openai_client", sentinel if openai else None)
        monkeypatch.setattr(qa_module, "_groq_client", sentinel if groq else None)
        monkeypatch.setattr(qa_module, "_local_client", sentinel if local else None)
        monkeypatch.setenv("QA_MODEL", qa_model)
        return sentinel

    def test_prefers_groq_over_local_when_both_are_free(self, monkeypatch):
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, groq=True, local=True)
        # Groq is hosted and answers better; the local CPU model is the
        # last free resort, not something to default everyone onto.
        assert resolve_default_model() == "llama-3.3-70b-versatile"

    def test_uses_local_when_it_is_the_only_free_provider(self, monkeypatch):
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, groq=False, local=True)
        assert resolve_default_model() == LOCAL_LLM_MODEL

    def test_falls_back_to_paid_only_when_nothing_free_is_configured(self, monkeypatch):
        """No free provider configured means paying is unavoidable -- but the
        cheapest paid model is a better default than the old `gpt-4`."""
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, openai=True, groq=False, local=False)
        chosen = resolve_default_model()
        assert qa_entry(chosen)["tier"] == "paid"
        assert chosen == "gpt-4o-mini"

    def test_explicit_openai_model_env_outranks_the_cheapest_paid(self, monkeypatch):
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, openai=True, groq=False, local=False)
        monkeypatch.setenv("OPENAI_MODEL", "gpt-4-turbo")
        assert resolve_default_model() == "gpt-4-turbo"

    def test_never_claims_a_paid_default_when_nothing_is_configured(self, monkeypatch):
        """With no provider at all the default is still named, not invented."""
        from app.services.qa import OPENAI_MODEL, resolve_default_model

        self._configure(monkeypatch, openai=False, groq=False, local=False)
        assert resolve_default_model() == OPENAI_MODEL

    def test_explicit_qa_model_env_is_honoured_even_when_paid(self, monkeypatch):
        """Naming a model is an operator decision, so it outranks free-first."""
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, groq=True, local=True, qa_model="gpt-4o")
        assert resolve_default_model() == "gpt-4o"

    def test_unknown_qa_model_env_is_ignored(self, monkeypatch):
        """A typo must not resolve to a model that does not exist."""
        from app.services.qa import resolve_default_model

        self._configure(monkeypatch, groq=True, qa_model="gpt-9-ultra")
        assert resolve_default_model() == "llama-3.3-70b-versatile"


class TestLocalProvider:
    """The keyless local OpenAI-compatible provider."""

    def test_local_client_uses_placeholder_key_and_base_url(self):
        """The SDK refuses to build a client with an empty key.

        That is the whole reason a placeholder exists: a local server ignores
        the credential, but the SDK still insists on one, so without this the
        keyless path could not be constructed at all.
        """
        from app.services import qa as qa_module

        assert qa_module._LOCAL_PLACEHOLDER_KEY
        client = qa_module.OpenAI(
            api_key=qa_module._LOCAL_PLACEHOLDER_KEY,
            base_url=qa_module.LOCAL_LLM_BASE_URL,
        )
        assert str(client.base_url).rstrip("/") == qa_module.LOCAL_LLM_BASE_URL

    def test_local_base_url_and_client_are_resolved_for_the_local_provider(
        self, monkeypatch
    ):
        from app.services import qa as qa_module

        fake = MagicMock()
        monkeypatch.setattr(qa_module, "_local_client", fake)

        assert qa_module._provider_client("local") is fake
        assert qa_module._provider_base_url("local") == qa_module.LOCAL_LLM_BASE_URL
        assert qa_module._is_provider_available("local") is True

    def test_local_is_not_available_until_explicitly_enabled(self, monkeypatch):
        from app.services import qa as qa_module

        monkeypatch.setattr(qa_module, "_local_client", None)
        assert qa_module._is_provider_available("local") is False
        assert qa_module.is_model_available(LOCAL_LLM_MODEL) is False

    def test_availability_is_local_inspection_not_a_network_call(self, monkeypatch):
        """Availability feeds a model list, so it must never call out."""
        from app.services import qa as qa_module

        def explode(*_args, **_kwargs):  # pragma: no cover - must never run
            raise AssertionError("availability must not make a network call")

        monkeypatch.setattr(qa_module, "OpenAI", explode)
        monkeypatch.setattr(qa_module, "_openai_client", None)
        monkeypatch.setattr(qa_module, "_groq_client", None)
        monkeypatch.setattr(qa_module, "_local_client", None)
        monkeypatch.setattr(qa_module, "_is_provider_available", qa_module._is_provider_available)

        for model_id in qa_module.AVAILABLE_MODELS:
            assert qa_module.is_model_available(model_id) is False

    def test_ask_uses_the_local_client_for_a_local_model(self, monkeypatch):
        from types import SimpleNamespace

        from app.services import qa as qa_module

        fake_local = MagicMock()
        fake_local.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Local answer"))]
        )
        monkeypatch.setattr(qa_module, "_local_client", fake_local)
        monkeypatch.setattr(qa_module, "_groq_client", None)
        monkeypatch.setattr(qa_module, "_openai_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        service = QAService(search_service=fake_search)

        response = service.ask(user_id=uuid4(), question="q")

        assert response.answer == "Local answer"
        assert response.model == LOCAL_LLM_MODEL
        assert (
            fake_local.chat.completions.create.call_args.kwargs["model"]
            == LOCAL_LLM_MODEL
        )

    def test_explicitly_asking_for_a_local_model_explains_the_env_vars(
        self, monkeypatch
    ):
        """Asking for a local model with none enabled must say what to set.

        Reached by naming the model, not by the default: with nothing
        configured the default resolves to a hosted entry, so the local hint
        would otherwise be unreachable text.
        """
        from app.services import qa as qa_module

        monkeypatch.setattr(qa_module, "_local_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        response = QAService(search_service=fake_search).ask(
            user_id=uuid4(), question="q", model=LOCAL_LLM_MODEL
        )

        assert response.answer.startswith("AI service is not configured.")
        assert "LOCAL_LLM_ENABLED" in response.answer
        assert "Ollama" in response.answer
        # A not-configured answer must never be cached.
        assert qa_module._is_uncacheable_answer(response.answer)


class TestLocalProviderOverRealHttp:
    """The local path against a real HTTP server, with no model weights.

    Mocking the client would prove nothing about the part most likely to be
    wrong: that an OpenAI-compatible server can actually be talked to without
    a key. The SDK refuses to build a client with an empty key, so this is the
    only way to show the placeholder gets a working request on the wire --
    nothing is downloaded, and no model is run.
    """

    @staticmethod
    @contextmanager
    def _serve():
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        captured: dict = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - stdlib naming
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                captured["path"] = self.path
                captured["auth"] = self.headers.get("Authorization")
                captured["model"] = body.get("model")
                captured["messages"] = body.get("messages")
                payload = json.dumps(
                    {
                        "id": "chatcmpl-stub",
                        "object": "chat.completion",
                        "created": 0,
                        "model": body.get("model"),
                        "choices": [
                            {
                                "index": 0,
                                "message": {
                                    "role": "assistant",
                                    "content": "Answer from the local server",
                                },
                                "finish_reason": "stop",
                            }
                        ],
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):  # silence the stub's logging
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        try:
            yield base_url, captured
        finally:
            server.shutdown()
            server.server_close()

    def test_keyless_client_completes_a_real_request(self):
        from app.services import qa as qa_module

        with self._serve() as (base_url, captured):
            client = qa_module.OpenAI(
                api_key=qa_module._LOCAL_PLACEHOLDER_KEY, base_url=base_url
            )
            response = client.chat.completions.create(
                model=LOCAL_LLM_MODEL,
                messages=[{"role": "user", "content": "hello"}],
            )

            assert response.choices[0].message.content == "Answer from the local server"
            # A real OpenAI-compatible request went out, addressed correctly and
            # carrying the placeholder credential.
            assert captured["path"] == "/v1/chat/completions"
            assert captured["model"] == LOCAL_LLM_MODEL
            assert captured["auth"] == f"Bearer {qa_module._LOCAL_PLACEHOLDER_KEY}"
            assert captured["messages"] == [{"role": "user", "content": "hello"}]


class TestQAResponseCarriesRetrievalMode:
    """Answer quality is bounded by retrieval quality, so the mode travels."""

    def _ask(self, mode, monkeypatch):
        from types import SimpleNamespace

        from app.services import qa as qa_module
        from app.schemas.search import SearchResponse

        fake_client = MagicMock()
        fake_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="A"))]
        )
        monkeypatch.setattr(qa_module, "_local_client", fake_client)
        monkeypatch.setattr(qa_module, "_groq_client", None)
        monkeypatch.setattr(qa_module, "_openai_client", None)

        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False, mode=mode
        )
        return QAService(search_service=fake_search).ask(user_id=uuid4(), question="q")

    def test_keyword_retrieval_is_reported_on_the_answer(self, monkeypatch):
        from app.schemas.search import SearchMode

        response = self._ask(SearchMode.keyword, monkeypatch)

        assert response.mode is SearchMode.keyword

    def test_semantic_retrieval_is_reported_on_the_answer(self, monkeypatch):
        from app.schemas.search import SearchMode

        response = self._ask(SearchMode.semantic, monkeypatch)

        assert response.mode is SearchMode.semantic


class TestLocalModelIdCollision:
    """A local model id that duplicates a hosted one must not corrupt the lists."""

    def test_colliding_local_id_is_dropped(self):
        from app.services.qa import _dedupe_local_entries

        registry = [
            {"id": "llama-3.3-70b-versatile", "provider": "groq", "tier": "free"},
            {"id": "llama-3.3-70b-versatile", "provider": "local", "tier": "free"},
            {"id": "llama3.2:1b", "provider": "local", "tier": "free"},
        ]

        deduped = _dedupe_local_entries(registry)

        # The hosted entry wins; a duplicate id would otherwise appear twice in
        # /qa/models and make the id lookup resolve to whichever came last.
        assert [e["provider"] for e in deduped] == ["groq", "local"]
        assert [e["id"] for e in deduped] == ["llama-3.3-70b-versatile", "llama3.2:1b"]

    def test_unique_local_id_is_kept(self):
        from app.services.qa import _dedupe_local_entries

        registry = [
            {"id": "a", "provider": "local", "tier": "free"},
            {"id": "b", "provider": "groq", "tier": "free"},
        ]

        assert _dedupe_local_entries(registry) == registry

    def test_the_shipped_registry_has_no_duplicate_ids(self):
        from app.services.qa import MODEL_REGISTRY

        ids = [entry["id"] for entry in MODEL_REGISTRY]
        assert len(ids) == len(set(ids))


class TestUnconfiguredProviderHint:
    """The first thing a user with no keys at all sees.

    Regression tests for #452. The hint used to be keyed by the *resolved*
    provider, and with nothing configured the resolver falls through to a paid
    OpenAI model -- so the message pointed the reader at `OPENAI_API_KEY`, the
    one option that costs money, and said nothing about the two free paths #448
    added. A regression test pins the content, so a later provider cannot
    quietly narrow the message again.
    """

    @staticmethod
    def _configured(monkeypatch, *providers: str):
        """Pin exactly which providers exist for this test.

        Every provider not named is made unavailable, so the result never
        depends on which keys happen to be set in the environment.
        """
        from app.services import qa as qa_module

        clients = {
            "openai": "_openai_client",
            "groq": "_groq_client",
            "local": "_local_client",
        }
        for name, attr in clients.items():
            monkeypatch.setattr(
                qa_module, attr, object() if name in providers else None
            )
        return qa_module

    def test_names_every_provider_when_nothing_is_configured(self, monkeypatch):
        qa_module = self._configured(monkeypatch)
        hint = qa_module.unconfigured_provider_hint("openai")

        assert "GROQ_API_KEY" in hint
        assert "LOCAL_LLM_ENABLED" in hint
        assert "OPENAI_API_KEY" in hint

    def test_says_which_options_are_free_and_which_are_paid(self, monkeypatch):
        """The whole point: a reader must not assume the first name is free."""
        qa_module = self._configured(monkeypatch)
        hint = qa_module.unconfigured_provider_hint("openai")
        lines = {
            line[2:].split(" (")[0]: line
            for line in hint.splitlines()
            if line.startswith("- ")
        }


        assert "free" in lines["Groq"]
        assert "free" in lines["Local model"]
        assert "paid" in lines["OpenAI"]

    def test_free_options_are_offered_before_the_paid_one(self, monkeypatch):
        """Derived from the registry's tiers, cheapest first."""
        qa_module = self._configured(monkeypatch)
        hint = qa_module.unconfigured_provider_hint("openai")
        order = [line for line in hint.splitlines() if line.startswith("- ")]

        assert order[0].startswith("- Groq")
        assert order[1].startswith("- Local model")
        assert order[-1].startswith("- OpenAI")

    def test_named_provider_cost_matches_the_registry_tier(self, monkeypatch):
        """A provider cannot be advertised as free while it bills."""
        qa_module = self._configured(monkeypatch)
        paid = {
            entry["provider"]
            for entry in qa_module.MODEL_REGISTRY
            if entry["tier"] == "paid"
        }

        for provider, setup in qa_module._PROVIDER_SETUP.items():
            if provider in paid:
                assert "paid" in setup["cost"], provider
            else:
                assert "free" in setup["cost"], provider

    def test_every_registry_provider_has_a_setup_row(self, monkeypatch):
        """A provider in the registry with no row here would be missing from
        the message -- the drift that caused #452."""
        qa_module = self._configured(monkeypatch)
        registry_providers = {entry["provider"] for entry in qa_module.MODEL_REGISTRY}

        assert registry_providers <= set(qa_module._PROVIDER_SETUP)

    def test_one_configured_provider_names_only_its_own_variable(
        self, monkeypatch
    ):
        """One provider set up, a different model asked for.

        Listing the other options here would wrongly suggest they are all
        unavailable, so only the requested provider is named -- plus a pointer to
        what already works.
        """
        qa_module = self._configured(monkeypatch, "groq")
        hint = qa_module.unconfigured_provider_hint("openai")

        assert "OPENAI_API_KEY" in hint
        assert "LOCAL_LLM_ENABLED" not in hint
        assert "Settings" in hint

    def test_the_answer_path_uses_the_same_wording(self, monkeypatch):
        """The API answer, not just the helper it delegates to."""
        qa_module = self._configured(monkeypatch)
        fake_search = MagicMock()
        fake_search.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )

        response = qa_module.QAService(search_service=fake_search).ask(
            user_id=uuid4(), question="q"
        )

        assert response.answer.startswith(qa_module.UNCONFIGURED_PREFIX)
        for variable in ("GROQ_API_KEY", "LOCAL_LLM_ENABLED", "OPENAI_API_KEY"):
            assert variable in response.answer
        # A not-configured answer must never be cached, or the missing key
        # would still be reported after one was added.
        assert qa_module._is_uncacheable_answer(response.answer)

    def test_unknown_provider_does_not_raise(self, monkeypatch):
        """A model id from a provider this build has never heard of must not
        turn into a KeyError and a 500."""
        qa_module = self._configured(monkeypatch)

        assert qa_module.unconfigured_provider_hint("some-future-provider")

    def test_building_the_hint_makes_no_network_call(self, monkeypatch):
        """Availability stays a local inspection.

        #448 established that the model list must never probe a provider, and
        this message is rendered in the same UI. If it tried to check that
        Groq is really reachable, a server with no outbound network would hang
        or fail while trying to explain that it has no key.
        """
        import urllib.request

        qa_module = self._configured(monkeypatch)

        def explode(*args, **kwargs):
            raise AssertionError("building the hint must not touch the network")

        monkeypatch.setattr(urllib.request, "urlopen", explode)
        monkeypatch.setattr(httpx, "post", explode)
        monkeypatch.setattr(httpx, "get", explode)

        assert qa_module.unconfigured_provider_hint("openai")
