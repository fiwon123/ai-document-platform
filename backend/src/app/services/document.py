import logging
import os
from urllib.parse import unquote
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status

from app.cache.redis import redis_client
from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.schemas.document import DocumentStatusResponse, FileResponse
from app.services.search import invalidate_user_search_cache
from app.storage.storage import MinioStorage
from app.worker import process_document_task

logger = logging.getLogger(__name__)

MAX_FILENAME_LENGTH = 255
MAX_UPLOAD_SIZE = 25 * 1024 * 1024  # 25 MB

# File types the text extraction service can handle (see text_extraction.py).
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".json"}
ALLOWED_MIME_TYPES = {
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "application/json",
}

DOCUMENT_CACHE_TTL_SECONDS = 300  # individual document metadata
DOCUMENT_LIST_CACHE_TTL_SECONDS = 60  # paginated listings
_DOCUMENT_KEY = "document:{owner_id}:{document_id}"
# One cached object per owner holding every recently-requested page:
# {"<skip>:<limit>": [FileResponse, ...], ...}. A single key per owner
# lets invalidation delete one entry instead of scanning page keys.
_DOCUMENT_LIST_KEY = "doclist:{owner_id}"


def _sanitize_filename(filename: str) -> str:
    """Strip path components and characters that break storage/DB keys."""
    # Clients can percent-encode control chars / separators in the filename
    # header (e.g. %00 or %2F); decode before any other checks.
    filename = unquote(filename)
    filename = os.path.basename(filename)
    # Remove null bytes and control characters (keep printable ASCII >= space).
    filename = "".join(ch for ch in filename if ch >= " " and ch != "\x7f")
    return filename.strip() or "unknown-file"


def invalidate_document_cache(owner_id: UUID, document_id: UUID) -> None:
    """Drop the cached metadata entry for a document.

    Called whenever a document's row changes (status transitions, deletes)
    so callers never serve stale metadata longer than necessary. The TTL
    provides a second line of defense if a caller forgets to invalidate.
    """
    try:
        redis_client.delete(_DOCUMENT_KEY.format(owner_id=owner_id, document_id=document_id))
    except Exception as e:  # noqa: BLE001 - cache must never break the caller
        logger.warning(f"Document cache invalidation failed: {e}")


def invalidate_document_list_cache(owner_id: UUID) -> None:
    """Drop all cached listing pages for a user's documents.

    Called after uploads and deletes so a fresh page is served next
    request. The short TTL is a second line of defense.
    """
    try:
        redis_client.delete(_DOCUMENT_LIST_KEY.format(owner_id=owner_id))
    except Exception as e:  # noqa: BLE001 - cache must never break the caller
        logger.warning(f"Document list cache invalidation failed: {e}")

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
        filename = _sanitize_filename(upload_file.filename or "unknown-file")

        # Validate filename length to prevent database DataError on INSERT.
        if len(filename) > MAX_FILENAME_LENGTH:
            # Truncate the extension if needed to fit within the limit.
            name, ext = os.path.splitext(filename)
            max_name_len = MAX_FILENAME_LENGTH - len(ext)
            if max_name_len < 1:
                filename = filename[:MAX_FILENAME_LENGTH]
            else:
                filename = f"{name[:max_name_len]}{ext}"

        if not filename or filename in (".", ".."):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid filename",
            )

        extension = os.path.splitext(filename)[1].lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Unsupported file type. "
                    "Allowed types: pdf, txt, md, csv, html, json."
                ),
            )

        content_type = upload_file.content_type
        if content_type and content_type not in ALLOWED_MIME_TYPES:
            # Some browsers send application/octet-stream for any file —
            # the extension allowlist above is the source of truth.
            if content_type != "application/octet-stream":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Unsupported file type. Allowed types: pdf, txt, md, csv, html, json.",
                )

        # Read up to MAX_UPLOAD_SIZE + 1 bytes: detects oversized files
        # without buffering the whole payload.
        content = upload_file.file.read(MAX_UPLOAD_SIZE + 1)
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="File too large. Maximum size is 25 MB.",
            )
        if not content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="File is empty.",
            )
        upload_file.file.seek(0)

        object_key = f"users/{owner_id}/documents/{document_id}/{filename}"

        try:
            self.storage.upload(
                file_object=upload_file.file,
                object_key=object_key,
                content_type=upload_file.content_type,
            )
        except Exception as e:
            logger.warning(f"Storage upload failed for {object_key}: {e}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Document storage is temporarily unavailable. Please try again.",
            ) from e

        try:
            document = DocumentDB(
                id=document_id,
                owner_id=owner_id,
                filename=filename,
                object_key=object_key,
                mime_type=upload_file.content_type,
                status=DocumentStatus.PENDING,
            )

            created = self.repository.create(document)
        except Exception as e:
            # Storage upload succeeded but DB insert failed — clean up the
            # orphaned object so we don't leak storage.
            try:
                self.storage.delete(object_key)
            except Exception as cleanup_error:  # noqa: BLE001 - best-effort cleanup
                logger.warning(
                    f"Failed to clean up object {object_key} "
                    f"after DB failure: {cleanup_error}"
                )
            logger.warning(f"Document DB create failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save document metadata. Please try again.",
            ) from e

        # The document set changed: any cached search results and any
        # cached listing pages for this user are now stale. The new
        # document's own metadata is not cached yet, so only invalidate
        # the search and list caches here.
        invalidate_user_search_cache(owner_id)
        invalidate_document_list_cache(owner_id)

        try:
            process_document_task(document_id)
        except Exception as e:
            # Processing failed even after the inline fallback (e.g. the
            # content could not be extracted). Never leave the document
            # stuck in pending; record the failure and return the
            # refreshed row so the client sees the final status.
            logger.warning(f"Processing failed for {document_id}: {e}")
            failed = self.repository.update_status(
                document_id,
                DocumentStatus.FAILED,
                error_message=f"Failed to process document: {e}",
            )
            if failed is not None:
                created = failed

        return created

    def get(self, document_id: UUID, owner_id: UUID):
        cached = self._get_cached_document(owner_id, document_id)
        if cached is not None:
            return cached

        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            return None

        self._cache_document(owner_id, document_id, document)
        return document

    def get_status(self, document_id: UUID, owner_id: UUID):
        """Return a minimal status object for polling clients."""
        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            return None

        return DocumentStatusResponse(
            id=document.id,
            status=document.status,
            error_message=document.error_message,
        )

    def list(self, owner_id: UUID, skip: int = 0, limit: int = 20):
        cached = self._get_cached_document_list(owner_id, skip, limit)
        if cached is not None:
            return cached

        documents = self.repository.get_by_owner(
            owner_id=owner_id,
            skip=skip,
            limit=limit,
        )
        self._cache_document_list(owner_id, skip, limit, documents)
        return documents

    def get_download_url(self, document_id: UUID, owner_id: UUID):
        document = self.get(document_id=document_id, owner_id=owner_id)
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

    def delete(self, document_id: UUID, owner_id: UUID):
        # Fetch a fresh ORM row directly: the cached FileResponse is not a
        # mapped instance and cannot be passed to repository.delete().
        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            return None

        self.storage.delete(document.object_key)
        self.repository.delete(document)
        invalidate_document_cache(owner_id, document_id)
        invalidate_user_search_cache(owner_id)
        invalidate_document_list_cache(owner_id)
        return document

    def _get_cached_document_list(
        self,
        owner_id: UUID,
        skip: int,
        limit: int,
    ) -> list[FileResponse] | None:
        try:
            payload = redis_client.get_json(
                _DOCUMENT_LIST_KEY.format(owner_id=owner_id)
            )
            if not isinstance(payload, dict):
                return None
            page = payload.get(f"{skip}:{limit}")
            if page is None:
                return None
            return [FileResponse.model_validate(item) for item in page]
        except Exception as e:  # noqa: BLE001 - fall back to the database
            logger.warning(f"Document list cache read failed: {e}")
            return None

    def _cache_document_list(
        self,
        owner_id: UUID,
        skip: int,
        limit: int,
        documents,
    ) -> None:
        try:
            key = _DOCUMENT_LIST_KEY.format(owner_id=owner_id)
            # Merge into the existing cached pages so requesting a new
            # page does not evict pages the client already loaded.
            payload: dict = redis_client.get_json(key) or {}
            payload[f"{skip}:{limit}"] = [
                FileResponse.model_validate(doc).model_dump(mode="json")
                for doc in documents
            ]
            redis_client.set_json(
                key,
                payload,
                ex=DOCUMENT_LIST_CACHE_TTL_SECONDS,
            )
        except Exception as e:  # noqa: BLE001 - cache write must never break reads
            logger.warning(f"Document list cache write failed: {e}")

    def _get_cached_document(self, owner_id: UUID, document_id: UUID) -> FileResponse | None:
        try:
            payload = redis_client.get_json(
                _DOCUMENT_KEY.format(owner_id=owner_id, document_id=document_id)
            )
            if payload is None:
                return None
            return FileResponse.model_validate(payload)
        except Exception as e:  # noqa: BLE001 - fall back to the database
            logger.warning(f"Document cache read failed: {e}")
            return None

    def _cache_document(self, owner_id: UUID, document_id: UUID, document: DocumentDB) -> None:
        try:
            serialized = FileResponse.model_validate(document).model_dump(mode="json")
            redis_client.set_json(
                _DOCUMENT_KEY.format(owner_id=owner_id, document_id=document_id),
                serialized,
                ex=DOCUMENT_CACHE_TTL_SECONDS,
            )
        except Exception as e:  # noqa: BLE001 - cache write must never break reads
            logger.warning(f"Document cache write failed: {e}")