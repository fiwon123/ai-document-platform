"""Tests for the search service and route (query embedding generation)."""

from unittest.mock import MagicMock
from uuid import UUID, uuid4

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.search import SearchRepository
from app.schemas.document import SearchResponse, SearchResult
from app.services.search import SearchService

DIM = 1536


def _make_vector(on_dim: int) -> list[float]:
    """One-hot style vector used to control cosine distances."""
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


class TestSearchServiceUnit:
    def test_search_generates_query_embedding_for_vector_search(self):
        repo = MagicMock()
        repo.search.return_value = ([], 0)
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
            offset=0,
            document_ids=None,
        )
        repo.save_search_history.assert_called_once()
        assert isinstance(response, SearchResponse)
        assert response.query == "hello world"

    def test_search_falls_back_to_text_search_when_embedding_unavailable(self):
        repo = MagicMock()
        repo.search.return_value = ([], 0)
        embedding = MagicMock()
        embedding.generate_embedding.side_effect = RuntimeError("no api key")
        user_id = uuid4()

        service = SearchService(repository=repo, embedding_service=embedding)
        response = service.search(user_id=user_id, query="hello world")

        repo.search.assert_called_once_with(
            user_id=user_id,
            query_embedding=None,
            top_k=5,
            offset=0,
            document_ids=None,
        )
        assert response.results == []

    def test_search_respects_top_k(self):
        repo = MagicMock()
        repo.search.return_value = ([], 0)
        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)

        service = SearchService(repository=repo, embedding_service=embedding)
        service.search(user_id=uuid4(), query="q", top_k=3)

        repo.search.assert_called_once_with(
            user_id=repo.search.call_args.kwargs["user_id"],
            query_embedding=_make_vector(0),
            top_k=3,
            offset=0,
            document_ids=None,
        )

    def test_search_forwards_document_ids_to_repository(self):
        repo = MagicMock()
        repo.search.return_value = ([], 0)
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
            offset=0,
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


class TestSearchPagination:
    def _seed_chunks(self, db_session, count: int = 3, marker: str = "a"):
        user = UserDB(
            username=f"page_user_{marker}", hashed_password="x"  # noqa: S106
        )
        db_session.add(user)
        db_session.flush()

        doc = DocumentDB(
            owner_id=user.id,
            filename=f"paged_{marker}.txt",
            object_key=f"k/paged_{marker}.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        chunks = [
            DocumentChunk(
                document_id=doc.id,
                content=f"section {i} content",
                chunk_index=i,
                embedding=_make_vector(i),
            )
            for i in range(count)
        ]
        db_session.add_all(chunks)
        db_session.commit()
        return user, doc

    def test_vector_search_pagination_and_total_count(self, db_session):
        user, _ = self._seed_chunks(db_session, count=3)
        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)
        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        )

        page1 = service.search(user_id=user.id, query="q", top_k=2, offset=0)
        assert len(page1.results) == 2
        assert page1.total_count == 3
        assert page1.has_more is True

        page2 = service.search(user_id=user.id, query="q", top_k=2, offset=2)
        assert len(page2.results) == 1
        assert page2.total_count == 3
        assert page2.has_more is False

        # Pages must not overlap and must cover everything.
        first_ids = {r.chunk_id for r in page1.results}
        second_ids = {r.chunk_id for r in page2.results}
        assert not first_ids & second_ids
        assert len(first_ids | second_ids) == 3

    def test_vector_search_total_count_counts_matching_chunks(self, db_session):
        """total_count counts this user's embeddable chunks only."""
        user, _ = self._seed_chunks(db_session, count=2, marker="user_a")
        # A chunk from ANOTHER user's document must not be counted.
        other, _ = self._seed_chunks(db_session, count=1, marker="user_b")

        embedding = MagicMock()
        embedding.generate_embedding.return_value = _make_vector(0)
        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        )

        response = service.search(user_id=user.id, query="q", top_k=10)

        assert response.total_count == 2
        assert all(r.document_filename == "paged_user_a.txt" for r in response.results)

    def test_text_fallback_pagination(self, db_session):
        """Embedding failure falls back to text search with paging."""
        user, _ = self._seed_chunks(db_session, count=3)
        embedding = MagicMock()
        embedding.generate_embedding.side_effect = RuntimeError("no api key")
        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        )

        page = service.search(user_id=user.id, query="q", top_k=2, offset=1)

        assert len(page.results) == 2
        assert page.total_count == 3
        assert page.has_more is False
        # Deterministic ordering: chunk_index 1 first, then 2.
        assert [r.metadata_ for r in page.results] == [None, None]
        assert [r.content for r in page.results] == ["section 1 content", "section 2 content"]

    def test_search_route_forwards_offset(self, client, auth_headers):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/",
                json={"query": "hello", "top_k": 5, "offset": 10},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        fake_service.search.assert_called_once()
        assert fake_service.search.call_args.kwargs["offset"] == 10

    def test_search_route_forwards_document_ids(self, client, auth_headers):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        doc_ids = [str(uuid4()), str(uuid4())]
        try:
            resp = client.post(
                "/v1/search/",
                json={"query": "hello", "top_k": 5, "document_ids": doc_ids},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        fake_service.search.assert_called_once()
        forwarded = fake_service.search.call_args.kwargs["document_ids"]
        assert forwarded == [UUID(d) for d in doc_ids]

    def test_search_route_defaults_document_ids_to_none(self, client, auth_headers):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="q", results=[], total_count=0, has_more=False
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/",
                json={"query": "hello"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        fake_service.search.assert_called_once()
        assert fake_service.search.call_args.kwargs["document_ids"] is None


class TestSearchRoute:
    def test_search_endpoint_returns_results(self, client, auth_headers):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(\
            query="q", results=[], total_count=0, has_more=False\
        )
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
        assert body == {"query": "q", "results": [], "total_count": 0, "has_more": False}
        fake_service.search.assert_called_once()


class TestSearchExport:
    """Export endpoint: CSV and JSON rendering of search results."""

    def _export_response(
        self, client, auth_headers, fmt: str, query: str = "hello"
    ):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query=query,
            results=[
                SearchResult(
                    chunk_id=UUID("00000000-0000-0000-0000-000000000001"),
                    document_id=UUID("00000000-0000-0000-0000-000000000002"),
                    document_filename="notes.txt",
                    content='contains "quoted, text" and newline\nline2',
                    score=0.123456,
                    metadata_={"page": 2},
                )
            ],
            total_count=1,
            has_more=False,
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/export",
                json={"query": query, "top_k": 5, "format": fmt},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()
        return resp

    def test_export_csv_success(self, client, auth_headers):
        resp = self._export_response(client, auth_headers, "csv")

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert 'attachment; filename="search_results.csv"' in resp.headers[
            "content-disposition"
        ]
        lines = resp.text.splitlines()
        assert lines[0] == (
            "document_filename,chunk_id,document_id,score,content,metadata"
        )
        # CSV quoting must handle commas, quotes, and newlines in content.
        assert lines[1].startswith('notes.txt,00000000-0000-0000-0000-000000000001,')
        assert '"contains ""quoted, text"" and newline\nline2"' in resp.text
        assert ",0.123456," in resp.text
        assert '"{""page"":2}"' in resp.text

    def test_export_csv_uses_correct_score_precision(self, client, auth_headers):
        resp = self._export_response(client, auth_headers, "csv")
        assert ",0.123456," in resp.text

    def test_export_csv_neutralizes_formula_injection(self, client, auth_headers):
        """Cells starting with =, +, -, @ must be prefixed so spreadsheets
        treat them as text instead of executing formulas (CSV injection)."""
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="q",
            results=[
                SearchResult(
                    chunk_id=UUID("00000000-0000-0000-0000-000000000001"),
                    document_id=UUID("00000000-0000-0000-0000-000000000002"),
                    document_filename="=cmd|'/c calc'!A0",
                    content="+SUM(A1:A2)",
                    score=0.5,
                    metadata_={"note": "@import"},
                )
            ],
            total_count=1,
            has_more=False,
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/export",
                json={"query": "q", "format": "csv"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        # Dangerous cells are neutralized with an apostrophe prefix.
        assert "'=cmd|'/c calc'!A0" in resp.text
        assert "'+SUM(A1:A2)" in resp.text
        # Metadata serializes to a JSON object starting with "{", which
        # spreadsheets never treat as a formula — no prefix needed.
        assert '"{""note"":""@import""}"' in resp.text

    def test_export_json_success(self, client, auth_headers):
        resp = self._export_response(client, auth_headers, "json")

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        assert 'attachment; filename="search_results.json"' in resp.headers[
            "content-disposition"
        ]
        body = resp.json()
        assert body["query"] == "hello"
        assert body["total_count"] == 1
        assert body["has_more"] is False
        result = body["results"][0]
        assert result["document_filename"] == "notes.txt"
        assert result["metadata_"] == {"page": 2}
        assert result["score"] == 0.123456

    def test_export_forwards_document_ids_and_skips_history(
        self, client, auth_headers
    ):
        from app.main import app
        from app.routes.search import get_search_service

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="hello", results=[], total_count=0, has_more=False
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        doc_ids = [str(UUID("00000000-0000-0000-0000-000000000002"))]
        try:
            resp = client.post(
                "/v1/search/export",
                json={
                    "query": "hello",
                    "top_k": 5,
                    "offset": 10,
                    "document_ids": doc_ids,
                    "format": "json",
                },
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        fake_service.search.assert_called_once()
        kwargs = fake_service.search.call_args.kwargs
        assert kwargs["document_ids"] == [UUID("00000000-0000-0000-0000-000000000002")]
        assert kwargs["offset"] == 10
        # Exports must not be recorded as search history.
        assert kwargs["record_history"] is False

    def test_export_requires_auth(self, client):
        resp = client.post(
            "/v1/search/export",
            json={"query": "hello", "format": "csv"},
        )
        assert resp.status_code == 401

    def test_export_rejects_invalid_format(self, client, auth_headers):
        resp = client.post(
            "/v1/search/export",
            json={"query": "hello", "format": "xml"},
            headers=auth_headers,
        )
        assert resp.status_code == 422