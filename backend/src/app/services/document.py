import os
from uuid import UUID, uuid4

from fastapi import UploadFile

from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.storage.storage import MinioStorage


class DocumentService:
    def __init__(
        self,
        repository: DocumentRepository,
        storage: MinioStorage,
    ):
        self.repository = repository
        self.storage = storage

    def upload(
        self,
        owner_id: UUID,
        upload_file: UploadFile,
    ):
        document_id = uuid4()

        # Prevent paths such as "../../secret.txt".
        filename = os.path.basename(
            upload_file.filename or "unknown-file",
        )

        object_key = (
            f"users/{owner_id}/documents/"
            f"{document_id}/{filename}"
        )

        try:
            self.storage.upload(
                file_object=upload_file.file,
                object_key=object_key,
                content_type=upload_file.content_type,
            )

            document = DocumentDB(
                id=document_id,
                owner_id=owner_id,
                filename=filename,
                object_key=object_key,
                mime_type=upload_file.content_type,
                status=DocumentStatus.PENDING,
            )

            return self.repository.create(document)

        except Exception:
            # Prevent an orphaned MinIO object if PostgreSQL fails.
            try:
                self.storage.delete(object_key)
            except Exception:
                pass

            raise

    def get(
        self,
        document_id: UUID,
        owner_id: UUID,
    ):
        return self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )

    def get_download_url(
        self,
        document_id: UUID,
        owner_id: UUID,
    ):
        document = self.get(
            document_id=document_id,
            owner_id=owner_id,
        )

        if document is None:
            return None

        return {
            "id": document.id,
            "filename": document.filename,
            "download_url": self.storage.create_download_url(
                document.object_key,
                expires_in=3600,
            ),
        }

    def delete(
        self,
        document_id: UUID,
        owner_id: UUID,
    ):
        document = self.get(
            document_id=document_id,
            owner_id=owner_id,
        )

        if document is None:
            return None

        # Delete the object first.
        self.storage.delete(document.object_key)

        # Then delete the database record.
        self.repository.delete(document)

        return document
