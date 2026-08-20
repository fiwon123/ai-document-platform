from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database.db import get_db
from ..repositories.file import FileRepository
from ..schemas.file import CreateFileRequest, UpdateFileRequest
from ..services.file import FileService

router = APIRouter(
    prefix="/files",
    tags="files"
)


def get_file_service(db: Annotated[Session, Depends(get_db)]) -> FileService:
    repo = FileRepository(db)
    return FileService(repo)


@router.get("/{id}", status_code=status.HTTP_200_OK)
def get_file(id: UUID, service: Annotated[FileService, Depends(get_file_service)]):

    result = service.get_by_id(id)

    if result is None:
        raise HTTPException(status=status.HTTP_404_NOT_FOUND,
                            detail="file not found")

    return result


@router.post("/", status_code=status.HTTP_200_OK)
def create_file(request: CreateFileRequest,
                service: Annotated[FileService, Depends(get_file_service)]):
    result = service.create(request.filename, request.file_path)

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="server error"
        )

    return result


@router.delete("/{id}", status_code=status.HTTP_200_OK)
def delete_file(id: UUID, service: Annotated[FileService, Depends(get_file_service)]):
    result = service.delete(id)

    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="file not found")

    return result


@router.patch("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def update_file(id: UUID,
                request: UpdateFileRequest,
                service: Annotated[FileService, Depends(get_file_service)]):

    data = request.model_dump(exclude_unset=True)

    result = service.update(id, data)

    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="file not found")
