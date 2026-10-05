import csv
import io
import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.search import SearchRepository
from app.routes.auth import get_current_user_id
from app.schemas.search import (
    SearchExportFormat,
    SearchExportRequest,
    SearchRequest,
    SearchResponse,
)
from app.services.search import SearchService

router = APIRouter(prefix="/search", tags=["search"])


def get_search_service(
    db: Annotated[Session, Depends(get_db)],
) -> SearchService:
    repository = SearchRepository(db)
    return SearchService(repository=repository)


@router.post("/", response_model=SearchResponse)
def search_documents(
    request: SearchRequest,
    service: Annotated[SearchService, Depends(get_search_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Semantically search the current user's document chunks.

    Embed the query, rank the user's chunks by vector similarity, and
    return the top hits (paginated with ``top_k`` + ``offset``, optional
    ``document_ids`` scope). ``total_count``/``has_more`` describe the full
    result set. Also records a search-history entry.
    """
    return service.search(
        user_id=owner_id,
        query=request.query,
        top_k=request.top_k,
        offset=request.offset,
        document_ids=request.document_ids,
    )


@router.post("/export")
def export_search_results(
    request: SearchExportRequest,
    service: Annotated[SearchService, Depends(get_search_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
) -> Response:
    """Run a search and return the results as a downloadable CSV or JSON file.

    Reuses the same service path as the regular search endpoint so filtering,
    user isolation, and text-search fallback behave identically. Exports do
    not write search-history rows (``record_history=False``), but they still
    go through the shared search cache like any other search.
    """
    response = service.search(
        user_id=owner_id,
        query=request.query,
        top_k=request.top_k,
        offset=request.offset,
        document_ids=request.document_ids,
        record_history=False,
    )

    if request.format == SearchExportFormat.json:
        payload = response.model_dump_json()
        return Response(
            content=payload,
            media_type="application/json",
            headers={
                "Content-Disposition": 'attachment; filename="search_results.json"'
            },
        )

    return Response(
        content=_to_csv(response),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="search_results.csv"'},
    )


# Characters that make a spreadsheet cell interpret its text as a formula
# (OpenFormula / Excel). When untrusted document content starts with one of
# these, we prefix the cell with an apostrophe so spreadsheets treat it as
# plain text and do not execute it (CSV formula injection).
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: str) -> str:
    if value.startswith(_CSV_FORMULA_PREFIXES):
        return f"'{value}"
    return value


def _to_csv(response: SearchResponse) -> str:
    """Serialize a SearchResponse into CSV (RFC 4180 via the csv module).

    The relevance column is headed ``distance`` and not ``score`` because the
    number is a distance: smaller is the better match. A file headed ``score``
    invites the reader to sort descending and get the *worst* matches first,
    which is the opposite of what they want from an export of search results.

    ``match_percent`` is the value the way the UI shows it, so a spreadsheet can
    be sorted high-to-low and read against what the user saw on screen. The
    exact metric behind the distance depends on the search mode (a cosine
    distance when semantic, a full-text rank distance when keyword), so the
    header says "distance" rather than naming a metric that would be wrong half
    the time.

    "The way the UI shows it" is the operative phrase, and it includes a clamp
    the UI applies and this file did not: ``MatchChip`` does
    ``Math.min(100, Math.max(0, pct))``. A cosine distance is bounded [0, 2], not
    [0, 1], so ``1 - score`` goes negative as soon as a hit is anti-correlated,
    and a ``match_percent`` of ``-3.4`` is not a percentage of anything. Clamped
    here for the same reason and to the same bounds. The two clamps cannot be
    shared across the API boundary, so each names the other.

    The distance column is left alone: 2.0 is a true cosine distance, and the API
    documents ``score`` as a distance rather than a bounded similarity.
    """
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "document_filename",
            "chunk_id",
            "document_id",
            "distance",
            "match_percent",
            "content",
            "metadata",
        ]
    )
    for result in response.results:
        writer.writerow(
            [
                _csv_safe(result.document_filename),
                str(result.chunk_id),
                str(result.document_id),
                f"{result.score:.6f}",
                # Clamped to match `MatchChip`; see the docstring for why a
                # cosine distance cannot be assumed to be within [0, 1].
                f"{min(100.0, max(0.0, (1 - result.score) * 100)):.1f}",
                _csv_safe(result.content),
                _csv_safe(_json_or_empty(result.metadata_)),
            ]
        )
    return output.getvalue()


def _json_or_empty(value: dict | None) -> str:
    """Serialize metadata to a compact JSON string (empty string when None)."""
    if value is None:
        return ""
    return json.dumps(value, separators=(",", ":"))