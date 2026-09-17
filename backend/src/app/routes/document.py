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
    DeleteDocumentResponse,
    DocumentPreviewResponse,
    DocumentStatusResponse,
    DownloadUrlResponse,
    FileResponse,
)
from app.services.document import DocumentService
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
    return service.upload(owner_id=owner_id, upload_file=upload_file)


@router.get("/", response_model=list[FileResponse])
def list_documents(
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
):
    return service.list(owner_id=owner_id, skip=skip, limit=limit)


@router.get("/{document_id}", response_model=FileResponse)
def get_document(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
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
    result = service.get_download_url(document_id=document_id, owner_id=owner_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )
    return result


@router.delete("/{document_id}", response_model=DeleteDocumentResponse)
def delete_document(
    document_id: UUID,
    service: Annotated[DocumentService, Depends(get_document_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
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
