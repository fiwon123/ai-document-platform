import re
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.document import DocumentRepository
from app.routes.auth import get_current_user_id
from app.schemas.document import (
    BulkUploadResponse,
    DeleteDocumentResponse,
    DocumentPreviewResponse,
    DocumentStatusResponse,
    DownloadUrlResponse,
    FileResponse,
    ReprocessDocumentResponse,
    ThumbnailUrlResponse,
)
from app.services.document import MAX_BULK_UPLOAD_FILES, DocumentService
from app.services.media_tokens import (
    KIND_THUMBNAIL,
    MEDIA_TOKEN_TTL_SECONDS,
    verify_token,
)
from app.storage.storage import storage

router = APIRouter(
    prefix="/documents",
    tags=["documents"],
)


def get_document_service(
    db: Annotated[Session, Depends(get_db)],
) -> DocumentService:
    repository = DocumentRepository(db)
    return DocumentService(repository=repository, storage=storage)


@router.post("/", status_code=status.HTTP_201_CREATED, response_model=FileResponse)
def upload_document(
    upload_file: Annotated[UploadFile, File(...)],
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Upload a single document for asynchronous processing.

    Stores the file in object storage (scoped to the current user) and
    enqueues it for background processing. The returned document starts in
    ``pending`` status; poll ``GET /v1/documents/{id}/status`` for progress.
    """
    return service.upload(owner_id=owner_id, upload_file=upload_file)


@router.post("/bulk", status_code=status.HTTP_201_CREATED, response_model=BulkUploadResponse)
def upload_documents_bulk(
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
    files: Annotated[list[UploadFile] | None, File()] = None,
):
    """Upload multiple documents in one request (multipart with repeated ``files``).

    Per-file errors are reported in the JSON response instead of failing the
    whole batch: each entry either lists the uploaded document or an
    ``error`` describing why that file was rejected. The number of files is
    capped at ``MAX_BULK_UPLOAD_FILES``.
    """
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No files provided. Send at least one file.",
        )
    if len(files) > MAX_BULK_UPLOAD_FILES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many files. Maximum is {MAX_BULK_UPLOAD_FILES} per request.",
        )
    return service.upload_bulk(owner_id=owner_id, upload_files=files)


@router.get("/", response_model=list[FileResponse])
def list_documents(
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    """List the current user's documents, newest first.

    Paginated with ``skip``/``limit`` (limit capped at 100). Returns the
    document metadata only — use the per-document endpoints for status,
    preview, download, or thumbnails.
    """
    return service.list(owner_id=owner_id, skip=skip, limit=limit)


@router.get("/{document_id}", response_model=FileResponse)
def get_document(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Fetch metadata for a single document owned by the current user.

    Returns 404 when the document does not exist or belongs to another user.
    """
    document = service.get(document_id=document_id, owner_id=owner_id)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return document


@router.get("/{document_id}/status", response_model=DocumentStatusResponse)
def get_document_status(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Get the async processing status of a document.

    Reports ``pending``/``processing``/``ready``/``failed`` plus the
    optional ``error_message`` and whether a first-page thumbnail exists
    (``has_thumbnail``). Useful for polling after upload.
    """
    result = service.get_status(document_id=document_id, owner_id=owner_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return result


@router.get("/{document_id}/preview", response_model=DocumentPreviewResponse)
def get_document_preview(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Return an excerpt of the extracted text for a ready document.

    Useful for a quick in-browser peek without downloading the file. Only
    available once processing has produced chunks — other statuses return a
    conflict (409).
    """
    result = service.preview(document_id=document_id, owner_id=owner_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return result


@router.get("/{document_id}/download", response_model=DownloadUrlResponse)
def get_download_url(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Get a short-lived presigned URL to download the original file.

    The URL expires (the object store signs it for a limited window), so
    clients should fetch promptly rather than store the link.
    """
    result = service.get_download_url(document_id=document_id, owner_id=owner_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return result


@router.get("/{document_id}/thumbnail", response_model=ThumbnailUrlResponse)
def get_document_thumbnail(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Get a presigned URL for the rendered first-page PNG preview.

    Returns 404 when no thumbnail exists for this document (non-PDF files,
    render failures, or processing that never reached the thumbnail step).
    The URL is time-limited by the object store's signing window.
    """
    result = service.get_thumbnail_url(document_id=document_id, owner_id=owner_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thumbnail not available for this document",
        )
    return result


@router.get(
    "/{document_id}/content",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {
                "image/png": {},
                "application/pdf": {},
                "application/octet-stream": {},
            }
        },
    },
)
def get_document_content(
    document_id: UUID,
    kind: Annotated[Literal["thumbnail", "original"], Query(description="Which asset")],
    token: Annotated[str, Query(description="Signed by the API; see media_tokens")],
    service: Annotated[DocumentService, Depends(get_document_service)],
):
    """Serve a document's bytes, authorised by the token in the query string.

    This is the endpoint the presigned storage URL used to point *at*, one hop
    closer. It exists because ``<img src>`` and a download link cannot send an
    ``Authorization`` header, so the authority has to travel in the URL — and
    because a storage URL has to name a host the browser can resolve, which is a
    guess that is wrong in every environment but one: the host-published port
    for a browser on the host, the service name for anything in the container,
    and an ingress name outside a cluster. The wrong guess fails silently as
    ``ERR_CONNECTION_REFUSED`` and the UI falls back to a placeholder, which
    reads as a missing feature rather than a misconfiguration (#536).

    Deliberately **not** behind ``get_current_user_id``: the token *is* the
    authorisation, which is the only thing that can work from an ``<img>``. It
    is scoped to one document, one kind, and
    ``MEDIA_TOKEN_TTL_SECONDS``; a request without a valid one is refused here,
    before the database is touched, so a forged link cannot even probe for the
    existence of a document.
    """
    if not verify_token(token, document_id, kind):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Link is invalid or has expired",
        )

    opened = service.open_asset(document_id=document_id, kind=kind)
    if opened is None:
        # The token was good, so the distinction that matters to a browser is
        # "nothing here", not "not allowed": 404, so an expired-preview card
        # falls back to its type chip instead of showing an error.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Thumbnail not available for this document"
                if kind == KIND_THUMBNAIL
                else "Document not found"
            ),
        )

    document, body, length = opened
    media_type = (
        "image/png"
        if kind == KIND_THUMBNAIL
        else (document.mime_type or "application/octet-stream")
    )
    # `filename` is attacker-influenced (it is whatever the user uploaded), so
    # strip anything that could end the header early or inject a field, and
    # quote what remains. RFC 6266: a bare ASCII fallback, then the real name.
    #
    # `safe=""` is load-bearing: quote() passes "/" through by default, and a
    # path separator is not an ext-value character (RFC 5987), so an unencoded
    # one hands the browser a suggested name with a directory in it. The ASCII
    # fallback above already reduced such a name to ".._.._etc_passwd"; the
    # encoded form has to be just as literal.
    safe = re.sub(r"[^\w .\-()\[\]]", "_", document.filename or "document")[:120]
    disposition = "inline" if kind == KIND_THUMBNAIL else "attachment"
    headers = {
        "Content-Disposition": (
            f'{disposition}; filename="{safe}"; '
            f"filename*=UTF-8''{quote(document.filename or 'document', safe='')}"
        ),
        # Private: the response is per-user, and a shared cache must not keep a
        # copy of someone's document after the token is gone.
        "Cache-Control": f"private, max-age={MEDIA_TOKEN_TTL_SECONDS}",
    }
    # Streamed rather than buffered: a 40 MB upload must not become 40 MB of
    # resident memory per concurrent download. The known length is still
    # advertised, so a browser can show a progress bar instead of guessing.
    headers["Content-Length"] = str(length)
    return StreamingResponse(
        body,
        media_type=media_type,
        headers=headers,
    )


@router.post(
    "/{document_id}/reprocess",
    status_code=status.HTTP_200_OK,
    response_model=ReprocessDocumentResponse,
)
def reprocess_document(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Re-run the processing pipeline on an existing document.

    Clears previous chunks/embeddings and re-enqueues the stored file
    (extraction → chunking → embeddings → thumbnail). Useful to recover from
    a transient failure or after pipeline changes.
    """
    return service.reprocess(document_id=document_id, owner_id=owner_id)


@router.delete("/{document_id}", response_model=DeleteDocumentResponse)
def delete_document(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Delete a document, its chunks, and its stored file.

    Also fires the ``document.deleted`` webhook event and invalidates the
    user's cached search/statistics data. Returns 404 when the document does
    not exist or belongs to another user.
    """
    document = service.delete(document_id=document_id, owner_id=owner_id)
    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return {
        "message": "Document deleted successfully",
        "document_id": document.id,
    }
