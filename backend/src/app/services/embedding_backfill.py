"""Recompute vectors for chunks that vector search cannot currently see.

Migration 008 added ``embedding_model`` and deliberately left pre-existing rows
NULL rather than guess which model had produced their vector, because a vector
is only comparable with vectors from the same model and ``ada-002`` /
``text-embedding-3-small`` are both 1536-wide, so nothing in the schema could
catch a wrong answer. A NULL row is therefore invisible to vector search (see
``app.repositories.search``), which is safe but leaves those documents
permanently unsearchable until something is done about them.

This module is that something. It **recomputes** each vector from the chunk's
``content`` — the source of truth — and writes the vector together with the
model that produced it. That is what makes this safe where a relabel would not
be: recomputing cannot be wrong about which model wrote a vector, because this
code is the thing that wrote it.

Deliberately *not* implemented: inferring the model of an existing vector. That
is the guess 008 refused, and no convenience makes it correct.

The tool fills one embedding space per run, because the active space is chosen
at import time (see ``app.services.embedding``). A deployment with an OpenAI key
keeps using the OpenAI space even when a local server is also configured, so
filling "the other" one is a deliberate config change plus a re-run, not a flag
here.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.chunk import LOCAL_EMBEDDING_SPACE, DocumentChunk, embedding_column_for
from app.services.embedding import EmbeddingDimensionMismatch, EmbeddingService

logger = logging.getLogger(__name__)

# Rows per page. Keyset pagination by id, not OFFSET: this is a long-running job
# over a table it is simultaneously updating, and OFFSET would rescan every row
# it already handled on every page.
PAGE_SIZE = 200

# Chunks per provider call.
DEFAULT_BATCH_SIZE = 32

# Why a row was not attempted. These are outcomes, not log lines: the point of
# the run is that an operator learns how many chunks stayed unsearchable and
# why, instead of assuming a successful run fixed everything.
SKIP_OTHER_SPACE = "other_space"
SKIP_NO_TEXT = "no_text"


@dataclass(frozen=True)
class BackfillPlan:
    """What a run would touch, counted before anything is written.

    ``already_current`` is counted separately from the skips because it is not a
    problem to fix — it is the idempotency guarantee made visible, so a re-run
    can be seen to have done nothing rather than having quietly relabelled rows.
    """

    to_embed: int
    already_current: int
    other_space: int
    no_text: int

    @property
    def total(self) -> int:
        return self.to_embed + self.already_current + self.other_space + self.no_text

    def summary(self) -> str:
        return (
            f"{self.total} chunk(s): {self.to_embed} to re-embed, "
            f"{self.already_current} already current, "
            f"{self.other_space} holding another space's vector, "
            f"{self.no_text} with no text"
        )


@dataclass
class BackfillResult:
    """What a run actually did."""

    embedded: int = 0
    batches: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def summary(self) -> str:
        parts = [f"embedded {self.embedded} chunk(s) in {self.batches} batch(es)"]
        for reason, count in sorted(self.skipped.items()):
            parts.append(f"skipped {count} ({reason})")
        return ", ".join(parts)


def require_active_space(service: EmbeddingService) -> tuple[str, str]:
    """The space and model to write, or a refusal naming the fix.

    Raises rather than returning empty: a backfill with no provider cannot do
    anything, and a run reporting "0 embedded, 0 skipped" for a misconfigured
    deployment reads like success.
    """
    space, model = service.space, service.model
    if space is None or model is None:
        raise RuntimeError(
            "No embedding provider is configured, so there is nothing to "
            "re-embed with. Set OPENAI_API_KEY for OpenAI embeddings, or set "
            "LOCAL_LLM_ENABLED=true (with LOCAL_EMBEDDING_MODEL) to use a "
            "local model server."
        )
    return space, model


def _other_column(space: str):
    """The column belonging to the space that is *not* ``space``."""
    if space == LOCAL_EMBEDDING_SPACE:
        return DocumentChunk.embedding
    return DocumentChunk.embedding_local


def _has_text():
    """Expression: the row has text a provider could embed.

    A chunk with empty content cannot be embedded, and writing a row with no
    vector and no reason anywhere is precisely what #488 stopped doing — so
    those are reported, never written.
    """
    return func.length(func.trim(func.coalesce(DocumentChunk.content, ""))) > 0


def _is_stale(column, model: str):
    """Expression: this row is not already a labelled vector for ``model``.

    ``is_(None)`` clauses are explicit rather than relying on ``!=``, which
    yields NULL for a NULL label and would drop exactly the rows this tool
    exists to fix.
    """
    return (
        (column.is_(None))
        | (DocumentChunk.embedding_model.is_(None))
        | (DocumentChunk.embedding_model != model)
    )


def plan_backfill(
    db: Session, *, service: EmbeddingService | None = None
) -> BackfillPlan:
    """Count what a run would do, without writing or calling the provider.

    Four counts in one statement, so the dry run stays one round trip on a
    corpus of any size instead of one query per bucket — or, worse, loading
    every row into Python to count it.
    """
    service = service or EmbeddingService()
    space, model = require_active_space(service)
    column = embedding_column_for(space)
    other = _other_column(space)
    stale = _is_stale(column, model)
    has_text = _has_text()

    row = db.query(
        func.count().filter(other.isnot(None)).label("other_space"),
        func.count().filter(other.is_(None), stale, ~has_text).label("no_text"),
        func.count().filter(other.is_(None), stale, has_text).label("to_embed"),
        func.count().filter(other.is_(None), ~stale).label("already_current"),
    ).one()

    return BackfillPlan(
        to_embed=row.to_embed,
        already_current=row.already_current,
        other_space=row.other_space,
        no_text=row.no_text,
    )


def run_backfill(
    db: Session,
    *,
    limit: int | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    service: EmbeddingService | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> BackfillResult:
    """Re-embed stale chunks in the active space, in batches.

    Skips rather than raises when a row cannot be written (another space's
    vector, or no text): one unmovable row should not abandon a run over
    thousands of others, but it is counted so it cannot pass unnoticed.

    A dimension mismatch is the exception. It is a configuration error — the
    operator named one model and configured the width of another — and retrying
    every remaining page against the same misconfiguration would turn one clear
    message into thousands of tracebacks, so it stops the run.
    """
    service = service or EmbeddingService()
    space, model = require_active_space(service)
    column = embedding_column_for(space)
    other = _other_column(space)

    plan = plan_backfill(db, service=service)
    result = BackfillResult()

    examined = 0
    last_id = None
    while limit is None or examined < limit:
        page_size = PAGE_SIZE if limit is None else min(PAGE_SIZE, limit - examined)
        query = db.query(
            DocumentChunk.id,
            DocumentChunk.content,
            column,
            other,
        ).filter(_is_stale(column, model))
        if last_id is not None:
            # Keyset, and before `limit`: SQLAlchemy refuses a `filter` on a
            # query that already has a LIMIT.
            query = query.filter(DocumentChunk.id > last_id)
        rows = query.order_by(DocumentChunk.id).limit(page_size).all()
        if not rows:
            break
        last_id = rows[-1].id
        examined += len(rows)

        # Every row here is stale by construction, so a row with text and no
        # foreign vector is re-embedded even when its own column already holds
        # something: a stale label over a present vector is exactly the case
        # that must be recomputed rather than relabelled.
        embeddable: list[tuple[str, str]] = []
        for chunk_id, content, _own_vector, other_vector in rows:
            if other_vector is not None:
                result.skip(SKIP_OTHER_SPACE)
            elif not content or not content.strip():
                result.skip(SKIP_NO_TEXT)
            else:
                embeddable.append((chunk_id, content))

        for start in range(0, len(embeddable), batch_size):
            _write_batch(
                db,
                embeddable[start : start + batch_size],
                column=column,
                model=model,
                service=service,
                result=result,
            )

        if on_progress:
            on_progress(examined, plan.to_embed)

    return result


def _write_batch(
    db: Session,
    batch: list[tuple[str, str]],
    *,
    column,
    model: str,
    service: EmbeddingService,
    result: BackfillResult,
) -> None:
    """Embed one batch and write it atomically with its model label."""
    try:
        vectors = service.generate_embeddings([content for _, content in batch])
    except EmbeddingDimensionMismatch:
        # Configuration, not transient: let it stop the run.
        raise
    except Exception:  # noqa: BLE001 - transient provider failure costs one batch
        logger.exception("backfill batch failed, continuing (%d chunks)", len(batch))
        return

    if len(vectors) != len(batch):
        # A short response means the provider returned a different number of
        # vectors than inputs. Pairing them positionally would attach each
        # vector to the wrong chunk, which is worse than skipping the batch.
        logger.error(
            "provider returned %d vectors for %d chunks, skipping the batch",
            len(vectors),
            len(batch),
        )
        return

    for (chunk_id, _), vector in zip(batch, vectors, strict=True):
        db.query(DocumentChunk).filter(DocumentChunk.id == chunk_id).update(
            {column.key: vector, "embedding_model": model},
            synchronize_session=False,
        )
    db.commit()
    result.embedded += len(batch)
    result.batches += 1
