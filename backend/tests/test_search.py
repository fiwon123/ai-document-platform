"""Tests for the search service and route (query embedding generation)."""

from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from app.models.chunk import (
    LOCAL_EMBEDDING_SPACE,
    OPENAI_EMBEDDING_SPACE,
    DocumentChunk,
)
from app.models.document import DocumentDB, DocumentStatus
from app.models.search import SearchHistory
from app.models.user import UserDB
from app.repositories.search import SearchOutcome, SearchRepository
from app.schemas.search import SearchMode, SearchResponse, SearchResult
from app.services.embedding import LOCAL_SPACE_CONFIG
from app.services.search import SearchService

DIM = 1536
# The local space's width, read from the service's own config so a deliberate
# change to it does not turn every local-space test into a false failure.
LOCAL_DIM = LOCAL_SPACE_CONFIG.dimensions

# The model these tests' vectors are attributed to. Chunk seeds must name it,
# because the search filters on `embedding_model`: a chunk with a vector but a
# NULL model is invisible to a vector search, which is the correct behaviour
# for a row written before that column existed and the wrong behaviour for a
# test that means to be found.
SEED_MODEL = "text-embedding-ada-002"


def _make_vector(on_dim: int) -> list[float]:
    """One-hot style vector used to control cosine distances."""
    return [1.0 if i == on_dim else 0.0 for i in range(DIM)]


def _make_local_vector(on_dim: int) -> list[float]:
    """The same idea at the local space's width, for the cross-space tests."""
    return [1.0 if i == on_dim else 0.0 for i in range(LOCAL_DIM)]


def _embedding_double(
    vector: list[float] | None = None, error: Exception | None = None
) -> MagicMock:
    """A stand-in EmbeddingService carrying its space and model.

    These two attributes are new load-bearing behaviour, not bookkeeping: the
    service forwards them so the repository knows which column to read and
    which model's vectors to compare against. A bare `MagicMock` would invent
    them as auto-mocks and make every assertion about them vacuous, so they are
    set to real values here.
    """
    embedding = MagicMock()
    embedding.space = OPENAI_EMBEDDING_SPACE
    embedding.model = SEED_MODEL
    if error is not None:
        embedding.generate_embedding.side_effect = error
    else:
        embedding.generate_embedding.return_value = vector
    return embedding


def _outcome(
    results: list[SearchResult], total_count: int, mode: SearchMode
) -> SearchOutcome:
    """A repository outcome, so a fake repository can be configured in one call."""
    return SearchOutcome(results, total_count, mode)


class TestSearchServiceUnit:
    def test_search_generates_query_embedding_for_vector_search(self):
        repo = MagicMock()
        repo.search.return_value = _outcome([], 0, SearchMode.semantic)
        embedding = _embedding_double(_make_vector(0))
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
            # Forwarded so the repository reads this space's column and only
            # ranks vectors this model produced.
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
        )
        repo.save_search_history.assert_called_once()
        assert isinstance(response, SearchResponse)
        assert response.query == "hello world"

    def test_search_falls_back_to_text_search_when_embedding_unavailable(self):
        repo = MagicMock()
        repo.search.return_value = _outcome([], 0, SearchMode.keyword)
        embedding = _embedding_double(error=RuntimeError("no api key"))
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
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
        )
        assert response.results == []
        assert response.mode == SearchMode.keyword

    def test_search_respects_top_k(self):
        repo = MagicMock()
        repo.search.return_value = _outcome([], 0, SearchMode.semantic)
        embedding = _embedding_double(_make_vector(0))

        service = SearchService(repository=repo, embedding_service=embedding)
        service.search(user_id=uuid4(), query="q", top_k=3)

        repo.search.assert_called_once_with(
            user_id=repo.search.call_args.kwargs["user_id"],
            query_embedding=_make_vector(0),
            query_text="q",
            top_k=3,
            offset=0,
            document_ids=None,
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
        )

    def test_search_forwards_document_ids_to_repository(self):
        repo = MagicMock()
        repo.search.return_value = _outcome([], 0, SearchMode.semantic)
        embedding = _embedding_double(_make_vector(0))
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
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
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
            embedding_model=SEED_MODEL,
        )
        chunk_cats = DocumentChunk(
            document_id=doc.id,
            content="cats are independent pets",
            chunk_index=1,
            embedding=_make_vector(1),
            embedding_model=SEED_MODEL,
        )
        db_session.add_all([chunk_dogs, chunk_cats])
        db_session.commit()

        embedding = _embedding_double(_make_vector(0))

        service = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        )
        response = service.search(user_id=user.id, query="dogs", top_k=2)

        assert len(response.results) == 2
        assert response.results[0].chunk_id == chunk_dogs.id
        assert response.results[0].score < response.results[1].score
        assert response.results[0].document_filename == "animals.txt"

    def test_score_is_a_distance_so_lower_means_a_better_match(self, db_session):
        """Pin the direction of `score`, which is a distance and not a score.

        The field name says "score" and readers assume higher is better, so a
        refactor that started returning a similarity (or inverted the ordering)
        would still return results in a sensible-looking order in some tests
        while breaking every consumer that sorts on the number. The one-hot
        vectors used here make the geometry exact: identical vectors are at
        distance 0.0 and orthogonal ones at 1.0.
        """
        user = UserDB(username="directions", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()

        doc = DocumentDB(
            owner_id=user.id,
            filename="directions.txt",
            object_key="k/directions.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()

        exact = DocumentChunk(
            document_id=doc.id,
            content="the exact match",
            chunk_index=0,
            embedding=_make_vector(0),
            embedding_model=SEED_MODEL,
        )
        unrelated = DocumentChunk(
            document_id=doc.id,
            content="an unrelated passage",
            chunk_index=1,
            embedding=_make_vector(1),
            embedding_model=SEED_MODEL,
        )
        db_session.add_all([exact, unrelated])
        db_session.commit()

        embedding = _embedding_double(_make_vector(0))
        response = SearchService(
            repository=SearchRepository(db_session),
            embedding_service=embedding,
        ).search(user_id=user.id, query="the exact match", top_k=2)

        assert response.results[0].chunk_id == exact.id
        # Lower is closer: the identical vector is 0.0 away, the orthogonal one
        # is 1.0 away, which is the maximum.
        assert response.results[0].score == pytest.approx(0.0, abs=1e-6)
        assert response.results[1].score == pytest.approx(1.0, abs=1e-6)
        # Both live in [0, 1] and are ordered closest-first.
        assert all(0.0 <= r.score <= 1.0 for r in response.results)
        assert [r.score for r in response.results] == sorted(
            r.score for r in response.results
        )
        # The conversion the UI relies on: 1 - distance is the match percentage.
        assert (1 - response.results[0].score) * 100 == pytest.approx(100, abs=1e-4)
        assert (1 - response.results[1].score) * 100 == pytest.approx(0, abs=1e-4)

    def test_score_field_documents_its_direction(self):
        """The direction has to survive in the schema, not just in this file.

        `score` reaches API consumers through the OpenAPI document, and the whole
        reason this field is confusing is that nothing said which way it points.
        """
        description = SearchResult.model_fields["score"].description or ""

        assert "smaller is a better match" in description
        assert "1 - score" in description


class TestEmbeddingSpaceIsolation:
    """Two providers, two columns, two models — and the filters that keep them apart.

    Everything here exists because the failure it guards is *silent*. Cosine
    distance computes a confident number between vectors from unrelated spaces,
    and it does so without error, so a query that strayed across a space or
    across a model would return plausible, confidently mis-ranked results rather
    than failing. Only an explicit filter prevents it.
    """

    def _seed(self, db_session, marker: str = "iso"):
        user = UserDB(username=marker, hashed_password="x")  # noqa: S106
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
        return user, doc

    def test_a_foreign_model_in_the_same_space_is_excluded(self, db_session):
        """The failure this column exists for.

        `text-embedding-ada-002` and `text-embedding-3-small` are both
        1536-wide, so nothing in the column type, the width check or the
        database distinguishes them — but they are unrelated spaces, and cosine
        distance across them returns a real number rather than an error. Without
        the `embedding_model` filter the 3-small chunk below would be ranked
        alongside the ada-002 chunk and reported as a match.
        """
        user, doc = self._seed(db_session, "foreign_model")
        mine = DocumentChunk(
            document_id=doc.id,
            content="in my space",
            chunk_index=0,
            embedding=_make_vector(0),
            embedding_model=SEED_MODEL,
        )
        theirs = DocumentChunk(
            document_id=doc.id,
            content="in another space",
            chunk_index=1,
            embedding=_make_vector(1),
            embedding_model="text-embedding-3-small",
        )
        db_session.add_all([mine, theirs])
        db_session.commit()

        outcome = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=_make_vector(0),
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
            top_k=10,
        )

        assert [c.chunk_id for c in outcome.results] == [mine.id]
        assert outcome.total_count == 1
        assert outcome.mode == SearchMode.semantic

    def test_a_chunk_with_a_vector_but_no_model_is_not_ranked(self, db_session):
        """A pre-existing vector is not silently adopted into the active model.

        Migration 008 leaves existing rows' `embedding_model` NULL rather than
        guessing it, because a wrong guess is indistinguishable from a right one
        until results are quietly mis-ranked. So a NULL row is invisible to a
        vector search, and the platform answers those queries by keyword until
        the document is re-embedded. This test pins that being the behaviour
        rather than an accident.
        """
        user, doc = self._seed(db_session, "null_model")
        legacy = DocumentChunk(
            document_id=doc.id,
            content="written before the model column existed",
            chunk_index=0,
            embedding=_make_vector(0),
            embedding_model=None,
        )
        db_session.add(legacy)
        db_session.commit()

        outcome = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=_make_vector(0),
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
            top_k=10,
        )

        assert outcome.results == []
        assert outcome.total_count == 0
        # No vector was comparable, so the honest mode is keyword — and the
        # keyword path can still find the chunk by its text.
        assert outcome.mode == SearchMode.semantic  # the vector query itself ran
        keyword = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=None,
            query_text="model column",
            top_k=10,
        )
        assert [c.chunk_id for c in keyword.results] == [legacy.id]

    def test_a_local_query_does_not_rank_openai_vectors(self, db_session):
        """The space column, not the model filter, is what separates these.

        Both chunks are attributed to models the search does not name, so the
        model filter would drop both; the result must come from reading the
        local column. Cosine distance would happily rank the 1536-wide row
        against a 768-wide query if the two shared a column — which is precisely
        the error pgvector raises instead, which the fallback then catches.
        """
        user, doc = self._seed(db_session, "cross_space")
        local_chunk = DocumentChunk(
            document_id=doc.id,
            content="embedded locally",
            chunk_index=0,
            embedding_local=_make_local_vector(0),
            embedding_model="nomic-embed-text",
        )
        db_session.add(local_chunk)
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="embedded by openai",
                chunk_index=1,
                embedding=_make_vector(1),
                embedding_model=SEED_MODEL,
            )
        )
        db_session.commit()

        outcome = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=_make_local_vector(0),
            query_space=LOCAL_EMBEDDING_SPACE,
            query_model="nomic-embed-text",
            top_k=10,
        )

        assert [c.chunk_id for c in outcome.results] == [local_chunk.id]

    def test_an_openai_query_does_not_rank_local_vectors(self, db_session):
        """The mirror image, so the previous test cannot pass by accident."""
        user, doc = self._seed(db_session, "cross_space_back")
        openai_chunk = DocumentChunk(
            document_id=doc.id,
            content="embedded by openai",
            chunk_index=0,
            embedding=_make_vector(0),
            embedding_model=SEED_MODEL,
        )
        db_session.add(openai_chunk)
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="embedded locally",
                chunk_index=1,
                embedding_local=_make_local_vector(1),
                embedding_model="nomic-embed-text",
            )
        )
        db_session.commit()

        outcome = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=_make_vector(0),
            query_space=OPENAI_EMBEDDING_SPACE,
            query_model=SEED_MODEL,
            top_k=10,
        )

        assert [c.chunk_id for c in outcome.results] == [openai_chunk.id]

    def test_an_unknown_space_is_refused_loudly(self, db_session):
        """A typo must fail at the point of use, not return an empty search.

        Defaulting an unknown space to some column is how a write goes to one
        column and a read from another, which is invisible until every search
        comes back empty.
        """
        user, _doc = self._seed(db_session, "bad_space")

        with pytest.raises(KeyError) as excinfo:
            SearchRepository(db_session).search(
                user_id=user.id,
                query_embedding=_make_vector(0),
                query_space="opneai",  # a typo, and a realistic one
                query_model=SEED_MODEL,
                top_k=10,
            )

        assert "unknown embedding space" in str(excinfo.value)


class TestVectorQueryFailureFallsBackToKeyword:
    """A vector query the database refuses must not become a 500.

    The realistic trigger is a misconfigured width: an operator changes the
    declared width of a model without changing its name, the new rows are
    refused by the write-side width check, and the *old* rows are still in the
    column at the old width. The distance query then meets two widths in one
    column and PostgreSQL raises — while the platform is perfectly able to
    answer the question by keyword.
    """

    def _seed_two_widths(self, db_session):
        """Two rows in the local column at different widths, same model name."""
        user = UserDB(username="mixed_width", hashed_password="x")  # noqa: S106
        db_session.add(user)
        db_session.flush()
        doc = DocumentDB(
            owner_id=user.id,
            filename="mixed.txt",
            object_key="k/mixed.txt",
            mime_type="text/plain",
            status=DocumentStatus.READY,
        )
        db_session.add(doc)
        db_session.flush()
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="a vector at the configured width",
                chunk_index=0,
                embedding_local=_make_local_vector(0),
                embedding_model="nomic-embed-text",
            )
        )
        db_session.add(
            DocumentChunk(
                document_id=doc.id,
                content="a vector at a different width under the same name",
                chunk_index=1,
                # Same model name, so the model filter cannot exclude it, but a
                # width the distance query will refuse. 384 is all-minilm's
                # width, so this is a real misconfiguration, not a fiction.
                embedding_local=[0.5] * 384,
                embedding_model="nomic-embed-text",
            )
        )
        db_session.commit()
        return user

    def test_a_refused_vector_query_degrades_to_keyword(self, db_session):
        user = self._seed_two_widths(db_session)

        outcome = SearchRepository(db_session).search(
            user_id=user.id,
            query_embedding=_make_local_vector(0),
            query_space=LOCAL_EMBEDDING_SPACE,
            query_model="nomic-embed-text",
            query_text="vector",
            top_k=10,
        )

        assert outcome.mode == SearchMode.keyword
        # The fallback is a *search*, not an error and not an enumeration: the
        # keyword path still has to find the chunks that mention the query.
        assert {c.chunk_id for c in outcome.results}
        assert all("vector" in c.content for c in outcome.results)

    def test_the_fallback_works_so_the_session_was_rolled_back(self, db_session):
        """The poisoned-transaction trap, pinned.

        A failed statement leaves the session's transaction aborted, so every
        statement after it fails with "current transaction is aborted". Without
        the rollback before the fallback, the fallback query would error too and
        the request would still 500 — with a far more confusing message, and the
        real cause (a vector-width problem) nowhere in sight.
        """
        user = self._seed_two_widths(db_session)
        repo = SearchRepository(db_session)

        outcome = repo.search(
            user_id=user.id,
            query_embedding=_make_local_vector(0),
            query_space=LOCAL_EMBEDDING_SPACE,
            query_model="nomic-embed-text",
            query_text="vector",
            top_k=10,
        )

        # The session is still usable for further work, which it would not be
        # had the failed statement been left in an aborted transaction: a commit
        # on an aborted session raises, so reaching the assertion is the test.
        repo.save_search_history(
            SearchHistory(user_id=user.id, query="vector", results_count=0)
        )
        assert (
            db_session.query(SearchHistory)
            .filter(SearchHistory.user_id == user.id)
            .count()
            == 1
        )
        assert outcome.results  # and the fallback really did query the database


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
                embedding_model=SEED_MODEL,
            )
            for i in range(count)
        ]
        db_session.add_all(chunks)
        db_session.commit()
        return user, doc

    def test_vector_search_pagination_and_total_count(self, db_session):
        user, _ = self._seed_chunks(db_session, count=3)
        embedding = _embedding_double(_make_vector(0))
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

        embedding = _embedding_double(_make_vector(0))
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
        embedding = _embedding_double(error=RuntimeError("no api key"))
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

        outcome = repo.search(
            user_id=user.id,
            query_embedding=None,
            query_text="content",
            top_k=2,
            offset=10,
        )

        assert outcome.results == []
        assert outcome.total_count == 0
        assert outcome.mode == SearchMode.keyword

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


class TestExportMatchPercentBounds:
    """A cosine distance is bounded [0, 2], so `1 - score` can go negative.

    `MatchChip` clamps to [0, 100] and the CSV has to agree with it, because the
    docstring promises the export carries the value the UI shows. These use the
    endpoint rather than `_to_csv` so the request path is what is pinned.
    """

    @staticmethod
    def _row(resp):
        header = resp.text.splitlines()[0].split(",")
        row = resp.text.splitlines()[1].split(",", len(header) - 1)
        return (
            float(row[header.index("distance")]),
            float(row[header.index("match_percent")]),
        )

    @pytest.mark.parametrize(
        ("distance", "expected_pct"),
        [
            (0.0, 100.0),  # identical vectors
            (0.123456, 87.7),  # the ordinary case, unchanged
            (0.5, 50.0),
            (1.0, 0.0),  # orthogonal vectors: the old worst case
            # Anti-correlated. Before the clamp these emitted -25.0, -50.0 and
            # -100.0, none of which is a percentage of a match.
            (1.25, 0.0),
            (1.5, 0.0),
            (2.0, 0.0),
        ],
    )
    def test_match_percent_stays_within_zero_to_one_hundred(
        self, client, auth_headers, distance, expected_pct
    ):
        from app.main import app
        from app.routes.search import get_search_service

        fake = MagicMock()
        fake.search.return_value = SearchResponse(
            query="hello",
            results=[
                SearchResult(
                    chunk_id=UUID("00000000-0000-0000-0000-000000000001"),
                    document_id=UUID("00000000-0000-0000-0000-000000000002"),
                    document_filename="notes.txt",
                    content="text",
                    score=distance,
                )
            ],
            total_count=1,
            has_more=False,
        )
        app.dependency_overrides[get_search_service] = lambda: fake
        try:
            resp = client.post(
                "/v1/search/export",
                json={"query": "hello", "top_k": 5, "format": "csv"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        exported_distance, match_percent = self._row(resp)
        assert match_percent == expected_pct
        assert 0.0 <= match_percent <= 100.0
        # The distance is a true cosine distance and is reported as found, so a
        # reader can tell that a hit was anti-correlated rather than merely poor.
        assert exported_distance == pytest.approx(distance, abs=1e-6)

    def test_distance_column_is_not_clamped_to_a_similarity(
        self, client, auth_headers
    ):
        """The clamp belongs to the percentage only.

        Rounding 2.0 down to 1.0 would make an anti-correlated hit
        indistinguishable from an orthogonal one, and the API documents `score`
        as a distance.
        """
        from app.main import app
        from app.routes.search import get_search_service

        fake = MagicMock()
        fake.search.return_value = SearchResponse(
            query="hello",
            results=[
                SearchResult(
                    chunk_id=UUID("00000000-0000-0000-0000-000000000001"),
                    document_id=UUID("00000000-0000-0000-0000-000000000002"),
                    document_filename="notes.txt",
                    content="text",
                    score=2.0,
                )
            ],
            total_count=1,
            has_more=False,
        )
        app.dependency_overrides[get_search_service] = lambda: fake
        try:
            resp = client.post(
                "/v1/search/export",
                json={"query": "hello", "top_k": 5, "format": "csv"},
                headers=auth_headers,
            )
        finally:
            app.dependency_overrides.clear()

        distance, match_percent = self._row(resp)
        assert distance == 2.0
        assert match_percent == 0.0


class TestSearchExport:
    """Export endpoint: CSV and JSON rendering of search results."""

    def _export_response(
        self,
        client,
        auth_headers,
        fmt: str,
        query: str = "hello",
        score: float = 0.123456,
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
                    score=score,
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
        # The relevance column is headed `distance`, not `score`: a file headed
        # `score` invites sorting descending, which puts the worst matches
        # first. `match_percent` carries the value the UI displays.
        assert lines[0] == (
            "document_filename,chunk_id,document_id,distance,match_percent,"
            "content,metadata"
        )
        # CSV quoting must handle commas, quotes, and newlines in content.
        assert lines[1].startswith('notes.txt,00000000-0000-0000-0000-000000000001,')
        assert '"contains ""quoted, text"" and newline\nline2"' in resp.text
        assert ",0.123456,87.7," in resp.text
        assert '"{""page"":2}"' in resp.text

    def test_export_csv_match_percent_is_the_inverse_of_distance(
        self, client, auth_headers
    ):
        """The two columns must move in opposite directions.

        If a future change ever made `match_percent` track the distance instead
        of its inverse, sorting it high-to-low would silently start returning
        the worst matches first -- the exact trap the rename was meant to close.
        """
        resp = self._export_response(client, auth_headers, "csv")
        header = resp.text.splitlines()[0].split(",")
        row = resp.text.splitlines()[1].split(",", len(header) - 1)

        distance = float(row[header.index("distance")])
        match_percent = float(row[header.index("match_percent")])

        assert distance == 0.123456
        assert match_percent == pytest.approx((1 - distance) * 100, abs=0.05)
        # Sanity: a perfect distance is a 100% match, the worst is 0%.
        assert (1 - 0.0) * 100 == 100
        assert (1 - 1.0) * 100 == 0

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
    """The mode must describe what actually happened, not what was hoped for.

    The service used to compute the mode from whether a query embedding had been
    generated, which is *intent*. That is wrong the moment the vector query is
    refused by the database: an embedding existed, so the response said
    `semantic` while the results came from a full-text scan. The repository now
    reports the mode as an outcome, and these tests pin that the service passes
    the reported mode through unchanged rather than re-deriving it.
    """

    def test_semantic_when_the_vector_query_ran(self):
        service = SearchService(repository=MagicMock())
        service.embedding_service = _embedding_double([0.1] * 1536)
        service.repository.search.return_value = _outcome(
            [], 0, SearchMode.semantic
        )

        response = service.search(user_id=uuid4(), query="q")

        assert response.mode is SearchMode.semantic

    def test_keyword_when_embedding_generation_fails(self):
        """No embedding means no vector query, so keyword is the truth."""
        service = SearchService(repository=MagicMock())
        service.embedding_service = _embedding_double(
            error=RuntimeError("OpenAI client not configured. Set OPENAI_API_KEY.")
        )
        service.repository.search.return_value = _outcome([], 0, SearchMode.keyword)

        response = service.search(user_id=uuid4(), query="q")

        assert response.mode is SearchMode.keyword
        # And the repository really was asked for a text search, not a vector
        # one -- the reported mode and the executed query cannot disagree.
        assert service.repository.search.call_args.kwargs["query_embedding"] is None

    def test_keyword_when_the_database_refused_the_vector_query(self):
        """The defect this whole change exists to prevent.

        An embedding *was* generated, so anything inferring the mode from intent
        reports `semantic` here. But the vector query failed inside the
        repository, which fell back to the keyword path — so reporting `semantic`
        would be labelling a full-text scan as a vector search. The mode must
        come from the outcome, which is the only thing that knows.
        """
        service = SearchService(repository=MagicMock())
        service.embedding_service = _embedding_double([0.1] * 1536)
        # The repository is the authority: it ran, and the vector part failed.
        service.repository.search.return_value = _outcome([], 0, SearchMode.keyword)

        response = service.search(user_id=uuid4(), query="q")

        assert response.mode is SearchMode.keyword
        # The query embedding was still generated -- which is exactly why the
        # mode must not be inferred from its presence.
        assert service.repository.search.call_args.kwargs["query_embedding"] is not None


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
                    embedding_model=SEED_MODEL,
                )
                for i, content in enumerate(contents)
            ]
        )
        db_session.commit()
        return user, doc

    def _search(self, db_session, user, query, **kwargs):
        """Run a keyword search and return the full outcome.

        The repository reports a `SearchOutcome` rather than a bare tuple,
        because the mode is part of the result. Tests that only care about hits
        or totals use the two accessors below instead of unpacking.
        """
        return SearchRepository(db_session).search(
            user_id=user.id, query_embedding=None, query_text=query, **kwargs
        )

    def _results(self, db_session, user, query, **kwargs) -> list[SearchResult]:
        """Just the ranked results."""
        return self._search(db_session, user, query, **kwargs).results

    def _page(self, db_session, user, query, **kwargs):
        """Results and the total number of matches, for pagination assertions."""
        outcome = self._search(db_session, user, query, **kwargs)
        return outcome.results, outcome.total_count

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

        results, total_count = self._page(
            db_session, user, "when is the pelican deployment window", top_k=2
        )

        assert total_count == 1
        assert len(results) == 1
        assert "pelican" in results[0].content

    def test_query_matching_nothing_returns_no_results(self, db_session):
        user, _ = self._seed(db_session, ["quarterly revenue increased", "office plants watered"])

        results, total_count = self._page(
            db_session, user, "sourdough bread baking schedule", top_k=5
        )

        assert results == []
        assert total_count == 0

    def test_stemming_finds_an_inflected_form(self, db_session):
        """Stemming is the reason to prefer full text over substring matching."""
        user, _ = self._seed(db_session, ["the pelican deployment window is thursday"])

        results = self._results(db_session, user, "deploying pelicans", top_k=5)

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

        results, total_count = self._page(
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

        results = self._results(db_session, user, "pelican deployment window", top_k=5)

        percent = (1 - results[0].score) * 100
        assert 0 <= percent <= 100

    def test_equal_scores_have_a_stable_order_across_calls(self, db_session):
        user, _ = self._seed(db_session, ["pelican alpha", "pelican beta", "pelican gamma"])

        orders = {
            tuple(r.chunk_id for r in self._results(db_session, user, "pelican", top_k=3))
            for _ in range(4)
        }

        assert len(orders) == 1

    def test_results_are_restricted_to_the_owning_user(self, db_session):
        user_a, _ = self._seed(db_session, ["pelican shared word"], marker="a")
        self._seed(db_session, ["pelican shared word"], marker="b")

        results, total_count = self._page(db_session, user_a, "pelican", top_k=10)

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

        results = self._results(db_session, user, "pelican", top_k=10, document_ids=[doc.id])

        assert {r.document_id for r in results} == {doc.id}

    def test_symbol_token_is_found_by_the_substring_fallback(self, db_session):
        """Full text tokenises away symbols; the fallback catches what it drops."""
        user, _ = self._seed(db_session, ["the service needs a c++ toolchain to build"])

        results, total_count = self._page(db_session, user, "c++", top_k=5)

        assert total_count == 1
        assert "c++" in results[0].content
        assert 0.0 <= results[0].score <= 1.0

    def test_like_wildcards_in_a_query_are_matched_literally(self, db_session):
        """A `%` or `_` from the user must not act as a SQL wildcard."""
        user, _ = self._seed(
            db_session, ["the coupon code is 50%_off for annual plans", "unrelated text"]
        )

        results = self._results(db_session, user, "50%_off", top_k=5)

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

        results = self._results(db_session, user, "c++ pelican perl", top_k=5)

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
            results, total_count = self._page(db_session, user, query, top_k=5)
            assert isinstance(results, list)
            assert isinstance(total_count, int)

    def test_empty_query_returns_nothing(self, db_session):
        """No query text means no match, not the whole corpus."""
        user, _ = self._seed(db_session, ["office plants are watered on fridays"])

        results, total_count = self._page(db_session, user, "", top_k=10)

        assert results == []
        assert total_count == 0

    def test_stopword_only_query_does_not_match_everything(self, db_session):
        """Short function words carry no signal and must not be substring-matched."""
        user, _ = self._seed(
            db_session, ["the quick brown fox", "another line of prose entirely"]
        )

        results = self._results(db_session, user, "a of the", top_k=10)

        assert results == []
