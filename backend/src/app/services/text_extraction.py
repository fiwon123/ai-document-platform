import io
from typing import BinaryIO


class TextExtractionService:
    def extract_text(self, file_object: BinaryIO, mime_type: str | None) -> str:
        if mime_type == "application/pdf":
            return self._extract_from_pdf(file_object)
        elif mime_type in (
            "text/plain",
            "text/markdown",
            "text/csv",
            "text/html",
        ):
            return self._extract_from_text(file_object)
        elif mime_type == "application/json":
            return self._extract_from_json(file_object)
        else:
            return self._extract_from_text(file_object)

    def _extract_from_pdf(self, file_object: BinaryIO) -> str:
        try:
            import PyPDF2

            reader = PyPDF2.PdfReader(file_object)
            text_parts = []
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    text_parts.append(text)
            return "\n\n".join(text_parts)
        except ImportError:
            return "[PDF extraction requires PyPDF2: pip install PyPDF2]"

    def _extract_from_text(self, file_object: BinaryIO) -> str:
        content = file_object.read()
        if isinstance(content, bytes):
            return content.decode("utf-8", errors="replace")
        return str(content)

    def _extract_from_json(self, file_object: BinaryIO) -> str:
        import json

        content = file_object.read()
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")

        try:
            data = json.loads(content)
            return json.dumps(data, indent=2, ensure_ascii=False)
        except json.JSONDecodeError:
            return content
