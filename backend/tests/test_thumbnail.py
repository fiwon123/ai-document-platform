"""Tests for visual document thumbnail generation and storage keys.

Rendering tests use a real PDF built in-memory with PyMuPDF itself, so no
external services or fixture files are needed. Worker/route integration
for thumbnails lives in test_worker.py and test_document.py respectively.
"""

import io

import fitz
import pytest

from app.services.thumbnail import (
    THUMBNAIL_FILENAME,
    ThumbnailService,
    can_render_thumbnail,
    thumbnail_object_key,
)


def _encrypted_pdf() -> bytes:
    buffer = io.BytesIO()
    document = fitz.open()
    try:
        page = document.new_page()
        page.insert_text((72, 72), "secret")
        document.save(
            buffer,
            encryption=fitz.PDF_ENCRYPT_AES_256,
            owner_pw="owner-pass",
            user_pw="user-pass",
        )
        return buffer.getvalue()
    finally:
        document.close()


def _pdf_without_pages() -> bytes:
    document = fitz.open()
    try:
        return document.tobytes()
    finally:
        document.close()


class TestRenderPng:
    def test_renders_first_page_as_png(self, pdf_bytes):
        png = ThumbnailService().render_png(pdf_bytes)

        assert png.startswith(b"\x89PNG")
        assert len(png) > 0

    def test_respects_max_width(self, pdf_bytes):
        png = ThumbnailService().render_png(pdf_bytes, max_width=200)

        image = fitz.open(stream=png, filetype="png")
        try:
            assert image[0].rect.width <= 200
        finally:
            image.close()

    def test_bounds_pathological_page_dimensions(self):
        # A page that is extremely tall relative to its width must still
        # yield a small pixmap: the zoom is clamped in both dimensions, so
        # rendering can never explode memory usage (1x10000pt pages etc.).
        document = fitz.open()
        try:
            page = document.new_page(width=10, height=10000)
            page.insert_text((72, 72), "tall")
            tall_pdf = document.tobytes()
        finally:
            document.close()

        png = ThumbnailService().render_png(tall_pdf, max_width=400)

        image = fitz.open(stream=png, filetype="png")
        try:
            assert image[0].rect.width <= 400
            assert image[0].rect.height <= 800  # 400 * 2x upscale cap
        finally:
            image.close()

    def test_rejects_empty_bytes(self):
        with pytest.raises(ValueError):
            ThumbnailService().render_png(b"")

    def test_rejects_corrupt_pdf(self):
        with pytest.raises(ValueError):
            ThumbnailService().render_png(b"this is not a pdf")

    def test_rejects_encrypted_pdf(self):
        with pytest.raises(ValueError):
            ThumbnailService().render_png(_encrypted_pdf())

    def test_rejects_pdf_without_pages(self):
        with pytest.raises(ValueError):
            ThumbnailService().render_png(_pdf_without_pages())


class TestCanRenderThumbnail:
    def test_pdf_mime(self):
        assert can_render_thumbnail("application/pdf", "report.pdf")

    def test_pdf_extension_is_case_insensitive(self):
        assert can_render_thumbnail(None, "report.PDF")

    def test_non_pdf_is_not_rendered(self):
        assert not can_render_thumbnail("text/plain", "notes.txt")
        assert not can_render_thumbnail("application/json", "data.json")

    def test_missing_mime_falls_back_to_extension(self):
        assert can_render_thumbnail(None, "guide.pdf")


class TestThumbnailObjectKey:
    def test_replaces_filename_in_document_folder(self):
        assert (
            thumbnail_object_key("users/u1/documents/d1/report.pdf")
            == "users/u1/documents/d1/thumbnail.png"
        )

    def test_uses_shared_filename_constant(self):
        assert THUMBNAIL_FILENAME == "thumbnail.png"