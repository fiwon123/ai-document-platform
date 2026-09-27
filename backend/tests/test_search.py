"""Tests for the search service and route (query embedding generation)."""

from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from app.models.chunk import DocumentChunk
from app.models.document import DocumentDB, DocumentStatus
from app.models.user import UserDB
from app.repositories.search import SearchRepository
from app.schemas.search import SearchResponse, SearchResult
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
            query_text="hello world",
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
            query_text="hello world",
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
            query_text="q",
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
            query_text="q",
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

        # Every seeded chunk contains "content", so this query matches all three
        # and the page boundaries are the thing under test.
        page = service.search(user_id=user.id, query="content", top_k=2, offset=1)

        assert len(page.results) == 2
        assert page.total_count == 3
        assert page.has_more is False
        # Deterministic ordering: equally-ranked chunks fall back to document
        # order, so chunk_index 1 comes first, then 2.
        assert [r.content for r in page.results] == ["section 1 content", "section 2 content"]

    def test_text_fallback_past_the_end_returns_nothing(self, db_session):
        """A page beyond the last match is empty, not a repeated first page.

        The keyword path tries a substring fallback when full-text finds
        nothing, so without this guard a caller paging past the end would get a
        first page of fallback matches instead of an empty page.
        """
        user, _ = self._seed_chunks(db_session, count=3)
        repo = SearchRepository(db_session)

        results, total_count = repo.search(
            user_id=user.id,
            query_embedding=None,
            query_text="content",
            top_k=2,
            offset=10,
        )

        assert results == []
        assert total_count == 0

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
        # `mode` is reported so a keyword-only deployment is visible rather
        # than indistinguishable from a fully indexed one.
        assert body == {
            "query": "q",
            "results": [],
            "total_count": 0,
            "has_more": False,
            "mode": "semantic",
        }
        fake_service.search.assert_called_once()

    def test_search_endpoint_reports_keyword_mode(self, client, auth_headers):
        """A response produced by the keyword fallback must say so."""
        from app.main import app
        from app.routes.search import get_search_service
        from app.schemas.search import SearchMode

        fake_service = MagicMock()
        fake_service.search.return_value = SearchResponse(
            query="q",
            results=[],
            total_count=0,
            has_more=False,
            mode=SearchMode.keyword,
        )
        app.dependency_overrides[get_search_service] = lambda: fake_service
        try:
            resp = client.post(
                "/v1/search/", json={"query": "hello"}, headers=auth_headers
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert resp.json()["mode"] == "keyword"


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

class TestSearchModeReporting:
    """The mode must describe what actually happened, not what was hoped for."""

    def test_semantic_when_the_query_was_embedded(self):
        from app.schemas.search import SearchMode
        from app.services.search import SearchService

        service = SearchService(repository=MagicMock())
        service.embedding_service = MagicMock()
        service.embedding_service.generate_embedding.return_value = [0.1] * 1536
        service.repository.search.return_value = ([], 0)

        response = service.search(user_id=uuid4(), query="q")

        assert response.mode is SearchMode.semantic

    def test_keyword_when_embedding_generation_fails(self):
        """The whole point: a failed embedding must not be reported as semantic."""
        from app.schemas.search import SearchMode
        from app.services.search import SearchService

        service = SearchService(repository=MagicMock())
        service.embedding_service = MagicMock()
        service.embedding_service.generate_embedding.side_effect = RuntimeError(
            "OpenAI client not configured. Set OPENAI_API_KEY."
        )
        service.repository.search.return_value = ([], 0)

        response = service.search(user_id=uuid4(), query="q")

        assert response.mode is SearchMode.keyword
        # And the repository really was asked for a text search, not a vector
        # one -- the reported mode and the executed query cannot disagree.
        assert service.repository.search.call_args.kwargs["query_embedding"] is None


class TestKeywordSearch:
    """Keyword search is the path a fresh checkout actually runs.

    Without an embedding provider the platform still answers searches, so this
    path has to *search*: match the query, rank by relevance, and report a score
    the UI can turn into a match percentage. Before #451 it applied no filter at
    all and returned the user's first N chunks in document order, so it answered
    every question with the beginning of the corpus.
    """

    @staticmethod
    def _seed(db_session, contents: list[str], marker: str = "kw"):
        user = UserDB(username=f"kw_{marker}", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()

        doc = DocumentDB(
            owner_id=user.id,
            filename=f"{marker}.txt",
            object_key=f"k/{marker}.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        db_session.add_all(
            [
                DocumentChunk(
                    document_id=doc.id, content=content, chunk_index=i,
                    embedding=_make_vector(i),
                )
                for i, content in enumerate(contents)
            ]
        )
        db_session.commit()
        return user, doc

    def _search(self, db_session, user, query, **kwargs):
        return SearchRepository(db_session).search(
            user_id=user.id, query_embedding=None, query_text=query, **kwargs
        )

    def test_finds_a_match_in_a_late_chunk(self, db_session):
        """The bug: a match beyond the first `top_k` chunks was unreachable."""
        user, _ = self._seed(
            db_session,
            [
                "office plants are watered on fridays",
                "nightly jobs reconcile invoices",
                "backups are verified monthly",
                "the pelican deployment window is thursday",
            ],
        )

        results, total_count = self._search(
            db_session, user, "when is the pelican deployment window", top_k=2
        )

        assert total_count == 1
        assert len(results) == 1
        assert "pelican" in results[0].content

    def test_query_matching_nothing_returns_no_results(self, db_session):
        user, _ = self._seed(db_session, ["quarterly revenue increased", "office plants watered"])

        results, total_count = self._search(
            db_session, user, "sourdough bread baking schedule", top_k=5
        )

        assert results == []
        assert total_count == 0

    def test_stemming_finds_an_inflected_form(self, db_session):
        """Stemming is the reason to prefer full text over substring matching."""
        user, _ = self._seed(db_session, ["the pelican deployment window is thursday"])

        results, _ = self._search(db_session, user, "deploying pelicans", top_k=5)

        assert len(results) == 1
        assert "pelican deployment" in results[0].content

    def test_scores_are_real_and_ordered_by_relevance(self, db_session):
        """Score stays a distance, so a better match is a *smaller* number.

        The UI renders `1 - score` as a match percentage; if keyword results
        reported something outside [0, 1] the match chips would show nonsense.
        Both chunks here satisfy the query — a space-separated `websearch_to_tsquery`
        ANDs its terms — so what separates them is term density, which is what
        `ts_rank` is for.
        """
        user, _ = self._seed(
            db_session,
            [
                "pelican deployment window thursday confirmed by ops",
                "pelican is a bird that ops watch from the window on thursday "
                "and deployment follows",
            ],
        )

        results, total_count = self._search(
            db_session, user, "pelican deployment window thursday", top_k=5
        )

        assert total_count == 2
        scores = [r.score for r in results]
        assert all(0.0 <= s <= 1.0 for s in scores), scores
        assert all(s > 0.0 for s in scores), "scores must not be the old hardcoded 0.0"
        # Non-increasing.
        assert scores == sorted(scores)
        # The chunk with the terms adjacent is the closer match.
        assert results[0].content.startswith("pelican deployment window")
        assert scores[0] < scores[1]

    def test_match_percentage_derived_from_score_is_sane(self, db_session):
        """Pin the contract the frontend depends on: 1 - score is a percentage."""
        user, _ = self._seed(db_session, ["the pelican deployment window is thursday"])

        results, _ = self._search(db_session, user, "pelican deployment window", top_k=5)

        percent = (1 - results[0].score) * 100
        assert 0 <= percent <= 100

    def test_equal_scores_have_a_stable_order_across_calls(self, db_session):
        user, _ = self._seed(db_session, ["pelican alpha", "pelican beta", "pelican gamma"])

        orders = {
            tuple(r.chunk_id for r in self._search(db_session, user, "pelican", top_k=3)[0])
            for _ in range(4)
        }

        assert len(orders) == 1

    def test_results_are_restricted_to_the_owning_user(self, db_session):
        user_a, _ = self._seed(db_session, ["pelican shared word"], marker="a")
        self._seed(db_session, ["pelican shared word"], marker="b")

        results, total_count = self._search(db_session, user_a, "pelican", top_k=10)

        assert total_count == 1
        assert len(results) == 1

    def test_document_filter_applies_to_keyword_results(self, db_session):
        user, doc = self._seed(db_session, ["pelican one", "pelican two"])
        other = DocumentDB(
            owner_id=user.id, filename="other.txt", object_key="k/other.txt",
            mime_type="text/plain", status=DocumentStatus.READY,
        )
        db_session.add(other)
        db_session.flush()
        db_session.add(DocumentChunk(document_id=other.id, content="pelican three", chunk_index=0))
        db_session.commit()

        results, _ = self._search(db_session, user, "pelican", top_k=10, document_ids=[doc.id])

        assert {r.document_id for r in results} == {doc.id}

    def test_symbol_token_is_found_by_the_substring_fallback(self, db_session):
        """Full text tokenises away symbols; the fallback catches what it drops."""
        user, _ = self._seed(db_session, ["the service needs a c++ toolchain to build"])

        results, total_count = self._search(db_session, user, "c++", top_k=5)

        assert total_count == 1
        assert "c++" in results[0].content
        assert 0.0 <= results[0].score <= 1.0

    def test_like_wildcards_in_a_query_are_matched_literally(self, db_session):
        """A `%` or `_` from the user must not act as a SQL wildcard."""
        user, _ = self._seed(
            db_session, ["the coupon code is 50%_off for annual plans", "unrelated text"]
        )

        results, _ = self._search(db_session, user, "50%_off", top_k=5)

        assert len(results) == 1
        assert "50%_off" in results[0].content

    def test_substring_fallback_ranks_by_term_coverage(self, db_session):
        """Coverage ordering, for a query full text cannot match at all.

        "c++" is dropped by the text search configuration, so the AND of the
        three terms matches nothing and the query is answered by the substring
        pass — which has no rank to work with, and falls back to counting how
        many query terms a chunk contains.
        """
        user, _ = self._seed(
            db_session,
            [
                "the service needs a c++ toolchain and pelican notes",
                "perl scripts only",
            ],
        )

        results, _ = self._search(db_session, user, "c++ pelican perl", top_k=5)

        assert results[0].content.startswith("the service needs a c++")
        assert results[1].content == "perl scripts only"
        # Coverage 2/3 is a closer match than coverage 1/3.
        assert results[0].score < results[1].score
        assert results[0].score == pytest.approx(1 - 2 / 3)
        assert results[1].score == pytest.approx(1 - 1 / 3)

    def test_odd_input_does_not_raise(self, db_session):
        """A pasted sentence or stray quote must not turn into a 500."""
        user, _ = self._seed(db_session, ["office plants are watered on fridays"])

        for query in ['"', "a AND OR NOT", "((((", "%%%", "   ", "x" * 300, "pelican OR ("]:
            results, total_count = self._search(db_session, user, query, top_k=5)
            assert isinstance(results, list)
            assert isinstance(total_count, int)

    def test_empty_query_returns_nothing(self, db_session):
        """No query text means no match, not the whole corpus."""
        user, _ = self._seed(db_session, ["office plants are watered on fridays"])

        results, total_count = self._search(db_session, user, "", top_k=10)

        assert results == []
        assert total_count == 0

    def test_stopword_only_query_does_not_match_everything(self, db_session):
        """Short function words carry no signal and must not be substring-matched."""
        user, _ = self._seed(
            db_session, ["the quick brown fox", "another line of prose entirely"]
        )

        results, _ = self._search(db_session, user, "a of the", top_k=10)

        assert results == []
