from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    UploadFile,
    status,
)
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.document import DocumentRepository
from app.schemas.document import FileResponse
from app.services.document import DocumentService
from app.storage.storage import storage

router = APIRouter(
    prefix="/documents",
    tags=["documents"],
)


def get_current_user_id() -> UUID:
    # Replace this with your JWT authentication dependency.
    return UUID("00000000-0000-0000-0000-000000000001")


def get_document_service(
    db: Annotated[Session, Depends(get_db)],
) -> DocumentService:
    repository = DocumentRepository(db)

    return DocumentService(
        repository=repository,
        storage=storage,
    )


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    response_model=FileResponse,
)
def upload_document(
    upload_file: Annotated[UploadFile, File(...)],
    service: Annotated[
        DocumentService,
        Depends(get_document_service),
    ],
):
    owner_id = get_current_user_id()

    return service.upload(
        owner_id=owner_id,
        upload_file=upload_file,
    )


@router.get("/{document_id}", response_model=FileResponse)
def get_document(
    document_id: UUID,
    service: Annotated[
        DocumentService,
        Depends(get_document_service),
    ],
):
    owner_id = get_current_user_id()

    document = service.get(
        document_id=document_id,
        owner_id=owner_id,
    )

    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    return document


@router.get("/{document_id}/download")
def get_download_url(
    document_id: UUID,
    service: Annotated[
        DocumentService,
        Depends(get_document_service),
    ],
):
    owner_id = get_current_user_id()

    result = service.get_download_url(
        document_id=document_id,
        owner_id=owner_id,
    )

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    return result


@router.delete("/{document_id}")
def delete_document(
    document_id: UUID,
    service: Annotated[
        DocumentService,
        Depends(get_document_service),
    ],
):
    owner_id = get_current_user_id()

    document = service.delete(
        document_id=document_id,
        owner_id=owner_id,
    )

    if document is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    return {
        "message": "Document deleted successfully",
        "document_id": document.id,
    }
