from typing import Annotated
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
