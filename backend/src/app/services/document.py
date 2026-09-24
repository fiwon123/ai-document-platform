import logging
import os
from io import BytesIO
from urllib.parse import unquote
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status

from app.cache.redis import redis_client
from app.models.document import DocumentDB, DocumentStatus
from app.repositories.document import DocumentRepository
from app.schemas.document import (
    BulkUploadFailure,
    BulkUploadResponse,
    DocumentPreviewResponse,
    DocumentStatusResponse,
    FileResponse,
)
from app.services.search import invalidate_user_search_cache
from app.services.text_extraction import TextExtractionService
from app.services.thumbnail import thumbnail_object_key
from app.storage.storage import MinioStorage
from app.worker import process_document_task

logger = logging.getLogger(__name__)

MAX_FILENAME_LENGTH = 255
MAX_UPLOAD_SIZE = 25 * 1024 * 1024  # 25 MB
PREVIEW_MAX_CHARS = 5000

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

DOCUMENT_CACHE_TTL_SECONDS = 60
_DOCUMENT_KEY = "document:{owner_id}:{document_id}"

# Maximum number of files accepted in a single bulk upload request.
MAX_BULK_UPLOAD_FILES = 20


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
        document = self._upload_one(owner_id=owner_id, upload_file=upload_file)

        # The document set changed: any cached search results for this
        # user are now stale (the new document is not included) and the
        # document's own metadata is not cached yet, so only invalidate
        # the search cache.
        invalidate_user_search_cache(owner_id)

        return document

    def upload_bulk(
        self,
        owner_id: UUID,
        upload_files: list[UploadFile],
    ) -> BulkUploadResponse:
        uploaded: list[FileResponse] = []
        failed: list[BulkUploadFailure] = []
        any_uploaded = False

        for upload_file in upload_files:
            try:
                document = self._upload_one(
                    owner_id=owner_id,
                    upload_file=upload_file,
                )
            except HTTPException as e:
                # FastAPI HTTPException detail is the human-readable message.
                detail = e.detail
                if isinstance(detail, str):
                    message = detail
                else:
                    message = "Upload failed"
                failed.append(
                    BulkUploadFailure(
                        filename=_sanitize_filename(
                            upload_file.filename or "unknown-file"
                        ),
                        error=message,
                    )
                )
                continue
            except Exception as e:  # noqa: BLE001 - per-file isolation
                safe_name = _sanitize_filename(upload_file.filename or "unknown-file")
                logger.warning(f"Bulk upload failed for {safe_name}: {e}")
                failed.append(
                    BulkUploadFailure(
                        filename=safe_name,
                        error="Upload failed. Please try again.",
                    )
                )
                continue

            uploaded.append(FileResponse.model_validate(document))
            any_uploaded = True

        if any_uploaded:
            invalidate_user_search_cache(owner_id)

        return BulkUploadResponse(uploaded=uploaded, failed=failed)

    def _upload_one(self, owner_id: UUID, upload_file: UploadFile) -> DocumentDB:
        """Validate, store, persist, and queue a single file.

        Raises ``HTTPException`` with the same messages as the single-file
        endpoint. Callers that need per-file error isolation (bulk upload)
        wrap this in try/except.
        """
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
            has_thumbnail=document.has_thumbnail,
            created_at=document.created_at,
            updated_at=document.updated_at,
        )

    def reprocess(self, document_id: UUID, owner_id: UUID):
        """Re-enqueue a terminal document (failed or ready) for processing.

        Returns a ``ReprocessDocumentResponse`` payload. Raises
        ``HTTPException`` 404 when the document is not owned by the user,
        and 409 when the document is currently pending/processing (a
        re-enqueue would race the running job).
        """
        from app.schemas.document import ReprocessDocumentResponse

        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found",
            )

        if document.status in (
            DocumentStatus.PENDING,
            DocumentStatus.PROCESSING,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Document is already being processed. "
                    "Wait for it to finish before retrying."
                ),
            )

        # Reset to pending and clear the stale error so the status endpoint
        # reports a clean in-flight state while the worker runs again.
        reset = self.repository.update_status(
            document_id,
            DocumentStatus.PENDING,
            error_message=None,
        )
        if reset is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found",
            )
        invalidate_document_cache(owner_id, document_id)
        invalidate_user_search_cache(owner_id)

        try:
            process_document_task(document_id)
        except Exception as e:  # noqa: BLE001 - surface the real processing error
            logger.warning(f"Reprocessing failed for {document_id}: {e}")
            failed = self.repository.update_status(
                document_id,
                DocumentStatus.FAILED,
                error_message=f"Failed to process document: {e}",
            )
            if failed is not None:
                invalidate_document_cache(owner_id, document_id)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Failed to process document: {e}",
            ) from e

        return ReprocessDocumentResponse(
            message="Document reprocessing started",
            document_id=document_id,
            status=DocumentStatus.PENDING,
        )

    def list(self, owner_id: UUID, skip: int = 0, limit: int = 20):
        return self.repository.get_by_owner(owner_id=owner_id, skip=skip, limit=limit)

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

    def get_thumbnail_url(self, document_id: UUID, owner_id: UUID):
        """Return a fresh presigned URL for the document's thumbnail.

        None when the document is not found or has no thumbnail (still
        pending, a non-PDF, or rendering failed).
        """
        document = self.get(document_id=document_id, owner_id=owner_id)
        if document is None or not document.has_thumbnail:
            return None

        return {
            "id": document.id,
            "thumbnail_url": self.storage.create_download_url(
                thumbnail_object_key(document.object_key),
                expires_in=3600,
            ),
        }

    def preview(self, document_id: UUID, owner_id: UUID):
        """Return a truncated text preview of the stored document.

        READY documents are previewed from their stored chunks (no MinIO
        round-trip or re-extraction); everything else falls back to
        reading the stored object, which also covers edge cases where a
        READY document has no chunks yet (e.g. pre-chunking uploads).
        """
        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            return None

        if document.status == DocumentStatus.READY:
            preview_text = self._preview_from_chunks(document_id)
            if preview_text is not None:
                return DocumentPreviewResponse(
                    id=document.id,
                    filename=document.filename,
                    preview=preview_text[:PREVIEW_MAX_CHARS],
                    truncated=len(preview_text) > PREVIEW_MAX_CHARS,
                )

        try:
            body = self.storage.download(document.object_key)
            try:
                raw = body.read()
            finally:
                # Close the streaming body so the connection is released.
                body.close()
        except Exception as e:
            logger.warning(f"Preview storage read failed for {document_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Document storage is temporarily unavailable. Please try again.",
            ) from e

        try:
            text = TextExtractionService().extract_text(
                BytesIO(raw),
                document.mime_type,
            )
        except Exception as e:
            logger.warning(f"Preview extraction failed for {document_id}: {e}")
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Could not extract text for preview.",
            ) from e

        return DocumentPreviewResponse(
            id=document.id,
            filename=document.filename,
            preview=text[:PREVIEW_MAX_CHARS],
            truncated=len(text) > PREVIEW_MAX_CHARS,
        )

    def _preview_from_chunks(self, document_id: UUID) -> str | None:
        """Rebuild the start of a READY document from its stored chunks.

        Chunks are extracted-text windows produced with a fixed overlap;
        the duplicated window is cut when stitching so the result matches
        the original extraction (approximate for tiny edge fragments).
        Returns ``None`` when the document has no chunks, so callers can
        fall back to the storage-based path.
        """
        contents = self.repository.get_preview_chunks(
            document_id, max_chars=PREVIEW_MAX_CHARS
        )
        if not contents:
            return None

        # Mirrors ChunkingService default overlap (see get_preview_chunks).
        overlap = 200
        stitched = contents[0]
        for content in contents[1:]:
            if not content:
                continue
            drop = min(overlap, len(content))
            for n in range(drop, 0, -1):
                if stitched.endswith(content[:n]):
                    stitched += content[n:]
                    break
            else:
                stitched += content
            if len(stitched) > PREVIEW_MAX_CHARS:
                break
        return stitched

    def delete(self, document_id: UUID, owner_id: UUID):
        # Fetch a fresh ORM row directly: the cached FileResponse is not a
        # mapped instance and cannot be passed to repository.delete().
        document = self.repository.get_by_id(
            document_id=document_id,
            owner_id=owner_id,
        )
        if document is None:
            return None

        # Snapshot the fields webhook payloads need *before* the delete
        # commit: the ORM instance is expired afterwards and the row is
        # gone, so detached-safe plain values must be captured while the
        # session can still read them.
        from app.services.webhook import document_event_info

        delete_info = document_event_info(document)

        self.storage.delete(document.object_key)
        # The thumbnail lives in the document's storage folder; removing it
        # keeps delete idempotent and prevents orphaned objects.
        try:
            self.storage.delete(thumbnail_object_key(document.object_key))
        except Exception as e:  # noqa: BLE001 - delete is already in flight
            logger.warning(
                f"Thumbnail cleanup failed for {document.object_key}: {e}"
            )
        self.repository.delete(document)
        invalidate_document_cache(owner_id, document_id)
        invalidate_user_search_cache(owner_id)
        # Notify webhook subscribers without blocking the response: the
        # delivery runs in a daemon thread and never raises into the
        # request cycle.
        from app.services.webhook import fire_webhook_background

        fire_webhook_background("document.deleted", delete_info)
        return document

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