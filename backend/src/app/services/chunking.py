from dataclasses import dataclass


@dataclass
class TextChunk:
    content: str
    chunk_index: int
    metadata: dict | None = None


class ChunkingService:
    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def chunk_text(self, text: str) -> list[TextChunk]:
        if not text.strip():
            return []

        chunks = []
        start = 0
        chunk_index = 0

        while start < len(text):
            end = start + self.chunk_size

            if end < len(text):
                break_point = self._find_break_point(text, start, end)
                if break_point > start:
                    end = break_point

            chunk_content = text[start:end].strip()

            if chunk_content:
                chunks.append(
                    TextChunk(
                        content=chunk_content,
                        chunk_index=chunk_index,
                        metadata={
                            "start_char": start,
                            "end_char": end,
                            "char_count": len(chunk_content),
                        },
                    )
                )
                chunk_index += 1

            start = end - self.chunk_overlap
            if start >= len(text):
                break

        return chunks

    def _find_break_point(self, text: str, start: int, end: int) -> int:
        paragraph_break = text.rfind("\n\n", start, end)
        if paragraph_break > start:
            return paragraph_break + 2

        sentence_break = text.rfind(". ", start, end)
        if sentence_break > start:
            return sentence_break + 2

        line_break = text.rfind("\n", start, end)
        if line_break > start:
            return line_break + 1

        word_break = text.rfind(" ", start, end)
        if word_break > start:
            return word_break + 1

        return end
