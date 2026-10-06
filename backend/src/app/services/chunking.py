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

            # The window normally advances by `chunk_size - chunk_overlap`.
            # It does not advance *at all* when the chosen break point sits
            # closer to `start` than the overlap: `_find_break_point` returns
            # the match position plus an adjustment (`\n\n` -> position + 2),
            # so a match in `(start, start + chunk_overlap]` makes `end` smaller
            # than `start + chunk_overlap`, and `end - chunk_overlap` then lands
            # *behind* the current start. From there the same break is found
            # again, so `start` never moves and an identical chunk is appended
            # on every iteration until the process runs out of memory (#688).
            #
            # Prefer the overlapping window, but only when it actually moves
            # forward; otherwise fall back to `end`, which is always > start
            # (it is either `start + chunk_size` or a break point > start).
            # This also covers `chunk_overlap >= chunk_size`, where every
            # window would otherwise be non-advancing.
            next_start = end - self.chunk_overlap
            if next_start <= start:
                next_start = end
            start = next_start
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
