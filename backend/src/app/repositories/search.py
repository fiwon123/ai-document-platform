import logging
import re
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import (
    Integer,
    String,
    case,
    column,
    func,
    literal_column,
    select,
    values,
)
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.chunk import DocumentChunk, embedding_column_for
from app.models.document import DocumentDB
from app.models.search import SearchHistory
from app.schemas.search import SearchMode, SearchResult

_INTERNAL_METADATA_KEYS = {"start_char", "end_char", "char_count"}


def _sanitize_metadata(metadata: dict | None) -> dict | None:
    if not metadata:
        return metadata
    return {k: v for k, v in metadata.items() if k not in _INTERNAL_METADATA_KEYS}


logger = logging.getLogger(__name__)

# The full-text search configuration, and the two expressions built from it.
# Kept as module-level names for one reason: the GIN index created by migration
# 007 is on the expression `to_tsvector('english', content)`, and Postgres only
# uses an expression index when the query repeats the expression *exactly*.
# Building it in two places is how a keyword search silently turns into a
# sequential scan.
TEXT_SEARCH_CONFIG = literal_column("'english'")


def full_text_vector(column):
    """``to_tsvector('english', <column>)`` — the indexed expression."""
    return func.to_tsvector(TEXT_SEARCH_CONFIG, column)


def full_text_query(text: str):
    """``websearch_to_tsquery('english', <text>)``.

    ``websearch_to_tsquery`` rather than ``plainto_tsquery`` because it never
    raises on odd input: quotes, lone punctuation, and boolean words are treated
    as plain terms instead of producing a query that errors out or silently
    matches nothing. A search box must not 500 on a pasted sentence.
    """
    return func.websearch_to_tsquery(TEXT_SEARCH_CONFIG, text)


# A term shorter than this carries no signal for substring matching: "a", "of"
# and "c" are in nearly every chunk, so including them makes every query match
# everything and ranks by nothing. Terms that contain a non-alphabetic character
# are exempt, because that is exactly the case the substring fallback exists for
# ("C++", "utf-8", "50%").
_MIN_SUBSTRING_TERM = 3
_TERM_SPLIT_RE = re.compile(r"[^\w.+#-]+", re.UNICODE)
# Bound the number of OR'd ILIKE terms so a pasted paragraph cannot produce an
# enormous CASE expression.
_MAX_SUBSTRING_TERMS = 12


def _candidate_terms(text: str) -> list[str]:
    """Lowercased terms worth testing, deduped and capped.

    Cheap and purely lexical — whether these terms mean anything is decided by
    the database, in `_terms_with_lexemes`.
    """
    terms: list[str] = []
    for raw in _TERM_SPLIT_RE.split(text.lower()):
        term = raw.strip()
        if not term:
            continue
        if len(term) < _MIN_SUBSTRING_TERM and term.isalpha():
            continue
        if term not in terms:
            terms.append(term)
        if len(terms) >= _MAX_SUBSTRING_TERMS:
            break
    return terms


def _like_pattern(term: str) -> str:
    """Escape LIKE wildcards so a term is matched literally.

    Without this, searching for "50%_off" or "a_b" silently becomes a wildcard
    search: ``%`` and ``_`` are metacharacters in both LIKE and ILIKE.
    """
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@dataclass(frozen=True)
class SearchOutcome:
    """What a search actually did, as opposed to what it set out to do.

    ``mode`` is reported rather than re-derived by the caller. It used to be
    computed from whether a query embedding had been generated, which is
    *intent*, not outcome: a vector query that fails against the database
    degrades to the keyword path, and a caller inferring the mode from the
    presence of an embedding would have reported ``semantic`` for results that
    came from a full-text scan.
    """

    results: list[SearchResult]
    total_count: int
    mode: SearchMode


class SearchRepository:
    def __init__(self, db: Session):
        self.db = db

    def _terms_with_lexemes(self, terms: list[str]) -> list[str]:
        """Drop the terms the text search configuration discards.

        Asking `to_tsvector('english', ...)` which terms survive keeps the
        stopword list in exactly one place — the Postgres dictionary the search
        itself uses — instead of copying English stopwords into Python where they
        would drift.

        This matters: "a of the" produces an *empty* tsquery, which matches
        nothing, and without this filter the query would fall through to substring
        matching on "the" and return most of the corpus. That is the very
        "always returns results" behaviour this path is supposed to have lost.
        """
        if not terms:
            return []

        # A VALUES table so every term is vectorised in one round trip, with an
        # explicit position to order by: the pairing between a term and its
        # vector must not depend on the database returning rows in order.
        candidates = values(
            column("position", Integer), column("term", String), name="candidate"
        ).data([(i, term) for i, term in enumerate(terms)])
        rows = self.db.execute(
            select(
                candidates.c.position,
                func.to_tsvector(TEXT_SEARCH_CONFIG, candidates.c.term),
            ).order_by(candidates.c.position)
        ).all()
        # One vector per candidate, in the order they were passed in, so the
        # result can be mapped straight back onto the terms. `strict` makes a
        # row-count mismatch an error instead of a silently short list.
        return [term for term, (_position, vector) in zip(terms, rows, strict=True) if vector]

    def search(
        self,
        user_id: UUID,
        query_embedding: list[float] | None,
        top_k: int = 5,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
        query_text: str = "",
        query_space: str | None = None,
        query_model: str | None = None,
    ) -> SearchOutcome:
        """Run a search and report how it was answered.

        ``query_text`` is only used by the keyword fallback, but it is required
        there: without an embedding provider there is nothing else to match on.

        ``query_space`` and ``query_model`` are only needed by the vector path,
        and describe the ``query_embedding``: which column holds comparable
        vectors, and which model produced them. Both are required for a vector
        search and ignored otherwise.
        """
        if query_embedding is None:
            results, total_count = self._text_search(
                user_id=user_id,
                query_text=query_text,
                top_k=top_k,
                offset=offset,
                document_ids=document_ids,
            )
            return SearchOutcome(results, total_count, SearchMode.keyword)

        try:
            results, total_count = self._vector_search(
                user_id=user_id,
                query_embedding=query_embedding,
                query_space=query_space,
                query_model=query_model,
                top_k=top_k,
                offset=offset,
                document_ids=document_ids,
            )
        except SQLAlchemyError as e:
            # The vector query failed against the database, so the keyword
            # fallback has to take over *inside* this repository rather than
            # being left to the caller's error handling: the alternative was a
            # 500 for a search the platform can still answer.
            #
            # The rollback is not optional. A failed statement leaves the
            # session's transaction aborted, so every statement after it fails
            # with "current transaction is aborted" — the fallback query would
            # error too, and the request would still 500, just with a more
            # confusing message.
            logger.warning(
                "Vector search failed (%s: %s); falling back to keyword search",
                type(e).__name__,
                e,
            )
            self.db.rollback()
            results, total_count = self._text_search(
                user_id=user_id,
                query_text=query_text,
                top_k=top_k,
                offset=offset,
                document_ids=document_ids,
            )
            return SearchOutcome(results, total_count, SearchMode.keyword)

        return SearchOutcome(results, total_count, SearchMode.semantic)

    @staticmethod
    def _apply_user_filter(query, user_id: UUID, document_ids: list[UUID] | None):
        """Restrict a search query to the user's own (optionally filtered)
        documents."""
        query = query.filter(DocumentDB.owner_id == user_id)
        if document_ids:
            query = query.filter(DocumentDB.id.in_(document_ids))
        return query

    def _run_page(
        self,
        user_id: UUID,
        score_expr,
        order_by,
        where,
        top_k: int,
        offset: int,
        document_ids: list[UUID] | None,
    ) -> tuple[list[SearchResult], int]:
        """Shared paging for both keyword strategies.

        ``COUNT(*) OVER ()`` computes the total matching rows in the same query
        that returns the page, avoiding a second round trip — and, importantly,
        counting only rows that passed ``where``, so a query that matches
        nothing reports ``total_count = 0`` instead of the size of the corpus.

        That count rides along on each returned row, so it is only readable when
        the page is non-empty. An empty page is ambiguous on its own — it can mean
        "nothing matched" (count 0, correct) or "you paged past the end" (count is
        whatever matched) — and the UI trusts this number: it takes ``total_count``
        from the last page it holds, so reporting 0 for the second case renders
        "Showing 5 of 0 results" beside five results. Hence the separate count
        when, and only when, the page comes back empty. The common path still
        costs one round trip.
        """
        query = self.db.query(
            DocumentChunk,
            DocumentDB.filename,
            score_expr.label("score"),
            func.count().over().label("total_count"),
        ).join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
        query = self._apply_user_filter(query, user_id, document_ids)
        query = query.filter(where)

        rows = query.order_by(*order_by).offset(offset).limit(top_k).all()
        if rows:
            total_count = rows[0].total_count
        else:
            # No row to read the window count from, so ask for it directly.
            # Swapping the selected entities for a COUNT and dropping the
            # ordering turns the page query into the plain count it now needs to
            # be; the filters are untouched, so this answers "how many matched",
            # not "how many exist".
            total_count = query.with_entities(func.count()).order_by(None).scalar() or 0

        return (
            [
                SearchResult(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    document_filename=filename,
                    content=chunk.content,
                    score=float(score),
                    metadata_=_sanitize_metadata(chunk.metadata_),
                )
                for chunk, filename, score, _ in rows
            ],
            int(total_count),
        )

    def _text_search(
        self,
        user_id: UUID,
        query_text: str,
        top_k: int,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
    ) -> tuple[list[SearchResult], int]:
        """Keyword search: match the query against the chunk text.

        This is the path taken whenever no embedding provider is configured,
        which is the state a fresh checkout is in, and the state #449 recorded as
        supported. It therefore has to *search*, not merely enumerate: the earlier
        version applied no filter at all and returned the user's first N chunks in
        document order, so a query matching the last chunk of a document could not
        find it, and a query matching nothing still looked like a hit (#451).

        Scoring keeps the same contract as the vector path: ``score`` is a
        *distance* in [0, 1] where smaller is closer, because the UI renders
        ``1 - score`` as a match percentage. A cosine distance and a text rank are
        different quantities, so they are not comparable to each other — only
        ordering within one result set is meaningful, which is all the UI uses.

        Two strategies, in order:

        1. Postgres full-text (``to_tsvector``/``ts_rank``). Stemming means
           "deploying" finds "deployment", and the GIN index from migration 007
           applies.
        2. Substring matching, used only when full-text found nothing. It catches
           what the english text search configuration discards — symbols, version
           strings, code identifiers. Ranked by how many query terms a chunk
           contains, because there is no rank to use.
        """
        vector = full_text_vector(DocumentChunk.content)
        tsquery = full_text_query(query_text)

        # Normalisation 32 is rank / (rank + 1): bounded to (0, 1), monotonic in
        # the raw rank, and free of any constant chosen to make the numbers look
        # better. The distance is its complement, so a stronger match is a
        # smaller score, exactly as in the vector path.
        rank = func.ts_rank(vector, tsquery, 32)

        results, total = self._run_page(
            user_id=user_id,
            score_expr=1.0 - rank,
            order_by=(rank.desc(), DocumentChunk.chunk_index, DocumentChunk.id),
            where=vector.op("@@")(tsquery),
            top_k=top_k,
            offset=offset,
            document_ids=document_ids,
        )
        if results or offset > 0:
            return results, total

        # No full-text match. Only try the substring pass on the first page: at a
        # non-zero offset an empty page legitimately means "past the end", and
        # answering it with a first page of substring matches would page the
        # wrong way.
        terms = self._terms_with_lexemes(_candidate_terms(query_text))
        if not terms:
            return [], 0

        # Coverage as a distance: a chunk containing every query term scores 0.0.
        matched = sum(
            case((DocumentChunk.content.ilike(_like_pattern(t), escape="\\"), 1), else_=0)
            for t in terms
        )
        return self._run_page(
            user_id=user_id,
            score_expr=1.0 - (matched / len(terms)),
            order_by=(matched.desc(), DocumentChunk.chunk_index, DocumentChunk.id),
            where=matched > 0,
            top_k=top_k,
            offset=offset,
            document_ids=document_ids,
        )

    def _vector_search(
        self,
        user_id: UUID,
        query_embedding: list[float],
        top_k: int,
        offset: int = 0,
        document_ids: list[UUID] | None = None,
        query_space: str | None = None,
        query_model: str | None = None,
    ) -> tuple[list[SearchResult], int]:
        """Rank chunks by cosine distance to the query embedding.

        The column comes from ``query_space`` rather than being hardcoded,
        because the local provider's vectors live in a different column (see
        `app.models.chunk`). Reading the space's column — the one the query
        vector is actually comparable with — is what keeps the two providers
        from being mixed: a local query must not rank OpenAI vectors and vice
        versa, and cosine distance would happily compute a number for either.

        ``embedding_model`` is the other half of that guarantee, and the one
        that catches what the space cannot: two *different* models in the same
        space and the same width (ada-002 and text-embedding-3-small are both
        1536) are indistinguishable to the column, and a query that compared
        against them would return confidently mis-ranked results.
        """
        embedding = embedding_column_for(query_space)
        distance = embedding.cosine_distance(query_embedding)

        query = self.db.query(
            DocumentChunk,
            DocumentDB.filename,
            distance.label("score"),
            func.count().over().label("total_count"),
        ).join(DocumentDB, DocumentChunk.document_id == DocumentDB.id)
        query = query.filter(embedding.isnot(None))
        if query_model is not None:
            query = query.filter(DocumentChunk.embedding_model == query_model)
        query = self._apply_user_filter(query, user_id, document_ids)

        rows = query.order_by(distance, DocumentChunk.id).offset(offset).limit(top_k).all()
        total_count = rows[0].total_count if rows else 0

        return (
            [
                SearchResult(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    document_filename=filename,
                    content=chunk.content,
                    score=float(score),
                    metadata_=_sanitize_metadata(chunk.metadata_),
                )
                for chunk, filename, score, _ in rows
            ],
            int(total_count),
        )

    def save_search_history(self, history: SearchHistory):
        self.db.add(history)
        self.db.commit()
