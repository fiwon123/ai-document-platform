"""Visual document thumbnails.

Renders the first page of a PDF as a small PNG image so the frontend can
show document cards with a real preview instead of a generic icon.

Thumbnail generation runs in the background worker and is strictly
best-effort: a render failure (corrupt/encrypted PDF) never fails the
document — the document still becomes READY, just without a thumbnail.
"""

import logging
import os

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# Generated thumbnails are capped to this width (px); height follows the
# page aspect ratio. Small enough for a card grid, large enough to read.
THUMBNAIL_WIDTH = 400

# Filename of the rendered object inside the document's storage folder.
THUMBNAIL_FILENAME = "thumbnail.png"


class ThumbnailService:
    """Render a PDF's first page to PNG bytes."""

    def render_png(self, pdf_bytes: bytes, max_width: int = THUMBNAIL_WIDTH) -> bytes:
        """Render the first page of ``pdf_bytes`` to a PNG image.

        Raises ``ValueError`` when the input is not a renderable PDF
        (empty, corrupt, encrypted, or without any pages) so callers can
        treat failures as non-fatal.
        """
        if not pdf_bytes:
            raise ValueError("Empty PDF bytes")

        try:
            document = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:  # noqa: BLE001 - normalize any parse failure
            raise ValueError("Unrenderable PDF") from e
        try:
            if document.needs_pass:
                raise ValueError("Encrypted PDF")
            if document.page_count == 0:
                raise ValueError("PDF has no pages")

            page = document[0]
            # Fit the page into a square box capped at max_width px on either
            # side, and never upscale beyond 2x. This bounds the pixmap even
            # for pathological aspect ratios (e.g. a 1x10000pt page) instead
            # of letting the taller dimension explode memory usage.
            page_width = max(float(page.rect.width), 1.0)
            page_height = max(float(page.rect.height), 1.0)
            scale = min(max_width / page_width, max_width / page_height, 2.0)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
            return pixmap.tobytes("png")
        finally:
            document.close()


def can_render_thumbnail(mime_type: str | None, filename: str) -> bool:
    """Only PDFs get visual thumbnails (text files keep a text preview)."""
    if mime_type == "application/pdf":
        return True
    return os.path.splitext(filename)[1].lower() == ".pdf"


def thumbnail_object_key(object_key: str) -> str:
    """Storage key for a document's thumbnail object.

    Sits in the same folder as the original so deleting the folder (or
    enforcing per-document prefixes) keeps working unchanged:
    ``users/{owner}/{doc}/thumbnail.png``.
    """
    folder = object_key.rsplit("/", 1)[0]
    return f"{folder}/{THUMBNAIL_FILENAME}"


thumbnail_service = ThumbnailService()
