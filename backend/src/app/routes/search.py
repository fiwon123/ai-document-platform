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
    """Serialize a SearchResponse into CSV (RFC 4180 via the csv module)."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "document_filename",
            "chunk_id",
            "document_id",
            "score",
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