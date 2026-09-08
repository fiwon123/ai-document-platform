"""Tests for the search service and route (query embedding generation)."""

from unittest.mock import MagicMock
from uuid import uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.search import SearchRepository
from app.schemas.document import SearchResponse
from app.services.search import SearchService

DIM = 1536


def _make_vector(on_dim: int) -> list[float]:
    """One-hot style vector used to control cosine distances."""
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


class TestSearchServiceUnit:
    def test_search_generates_query_embedding_for_vector_search(self):
        repo = MagicMock()
        repo.search.return_value = []
        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)
        user_id = uuid4()

        service = SearchService(repository=repo, embedding_service=embedding)
        response = service.search(user_id=user_id, query="hello world")

        embedding.generate_embedding.assert_called_once_with("hello world")
        repo.search.assert_called_once_with(
            user_id=user_id,
            query_embedding=_make_vector(0),
            top_k=5,
            document_ids=None,
        )
        repo.save_search_history.assert_called_once()
        assert isinstance(response, SearchResponse)
        assert response.query == "hello world"

    def test_search_falls_back_to_text_search_when_embedding_unavailable(self):
        repo = MagicMock()
        repo.search.return_value = []
        embedding = MagicMock()
        embedding.generate_embedding.side_effect = RuntimeError("no api key")
        user_id = uuid4()

        service = SearchService(repository=repo, embedding_service=embedding)
        response = service.search(user_id=user_id, query="hello world")

        repo.search.assert_called_once_with(
            user_id=user_id,
            query_embedding=None,
            top_k=5,
            document_ids=None,
        )
        assert response.results == []

    def test_search_respects_top_k(self):
        repo = MagicMock()
        repo.search.return_value = []
        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)

        service = SearchService(repository=repo, embedding_service=embedding)
        service.search(user_id=uuid4(), query="q", top_k=3)

        repo.search.assert_called_once_with(
            user_id=repo.search.call_args.kwargs["user_id"],
            query_embedding=_make_vector(0),
            top_k=3,
            document_ids=None,
        )

    def test_search_forwards_document_ids_to_repository(self):
        repo = MagicMock()
        repo.search.return_value = []
        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)
        user_id = uuid4()
        document_ids = [uuid4(), uuid4()]

        service = SearchService(repository=repo, embedding_service=embedding)
        service.search(user_id=user_id, query="q", document_ids=document_ids)

        repo.search.assert_called_once_with(
            user_id=user_id,
            query_embedding=_make_vector(0),
            top_k=5,
            document_ids=document_ids,
        )


class TestVectorSearchWithDatabase:
    def test_vector_search_returns_ranked_results(self, db_session):
        user = UserDB(username="alice", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()

        doc = DocumentDB(
            owner_id=user.id,
            filename="animals.txt",
            object_key="users/k/animals.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        chunk_dogs = DocumentChunk(
            document_id=doc.id,
            content="dogs are loyal pets",
            chunk_index=0,
            embedding=_make_vector(0),
        )
        chunk_cats = DocumentChunk(
            document_id=doc.id,
            content="cats are independent pets",
            chunk_index=1,
            embedding=_make_vector(1),
        )
        db_session.add_all([chunk_dogs, chunk_cats])
        db_session.commit()

        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)

        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        )
        response = service.search(user_id=user.id, query="dogs", top_k=2)

        assert len(response.results) == 2
        assert response.results[0].chunk_id == chunk_dogs.id
        assert response.results[0].score < response.results[1].score
        assert response.results[0].document_filename == "animals.txt"


class TestSearchRoute:
    def test_search_endpoint_returns_results(self, client, auth_headers):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(query="q", results=[])
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/",
                json={"query": "hello", "top_k": 5},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        body = resp.json()
        assert body == {"query": "q", "results": []}
        fake_service.search.assert_called_once()