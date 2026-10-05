"""Re-embed chunks that vector search cannot currently see.

Migration 008 left every pre-existing row with a NULL ``embedding_model`` rather
than guess which model had produced its vector, which makes those chunks
invisible to semantic search until they are recomputed. This is the operator
tool that does it: see ``app.services.embedding_backfill``.

A dry run is the default. Writing is opt-in (``--apply``) because the run costs
money and cannot be undone except by re-running the worker over the documents,
and because the first thing an operator should see is *how many* rows are
involved.

    uv run python scripts/backfill_embeddings.py                 # dry run
    uv run python scripts/backfill_embeddings.py --limit 50      # dry run, bounded
    uv run python scripts/backfill_embeddings.py --apply         # write

The run fills one embedding space: whichever is active (see
``app.services.embedding``). If a deployment needs the other space filled too,
that is a config change and a second run, not a flag here.
"""

from __future__ import annotations

import argparse
import logging
import sys

from app.database.db import SessionLocal
from app.services.embedding import EmbeddingService
from app.services.embedding_backfill import (
    DEFAULT_BATCH_SIZE,
    plan_backfill,
    require_active_space,
    run_backfill,
)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Re-embed chunks whose vectors vector search cannot use. "
            "Dry run unless --apply is given."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write the vectors (default: report only, write nothing)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="stop after examining N stale chunks (for a bounded first run)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        metavar="N",
        help=f"chunks per provider call (default: {DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="log each failed batch"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    service = EmbeddingService()
    try:
        space, model = require_active_space(service)
    except RuntimeError as exc:
        # Exit 2, not a traceback: this is a misconfiguration to fix in the
        # environment, and a stack trace would bury the sentence that says how.
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"active embedding space: {space} (model: {model})")
    if space != "openai":
        print(
            "note: this run fills the local space only. Any rows holding an "
            "OpenAI vector are reported, not overwritten — the database forbids "
            "one row holding both. Switch the active space and run again for "
            "the other one."
        )

    with SessionLocal() as db:
        plan = plan_backfill(db, service=service)
        print(f"dry run: {plan.summary()}")
        if not args.apply:
            if args.limit is not None:
                # `--limit` bounds the work a write run does. It is not a dry-run
                # filter, so say what it would do rather than leaving a flag that
                # is accepted, printed in the help text, and quietly ignored.
                print(
                    f"a run with --limit {args.limit} would examine at most "
                    f"{min(args.limit, plan.total)} chunk(s) of these"
                )
            print("no writes (pass --apply to re-embed)")
            return 0
        if plan.to_embed == 0:
            print("nothing to do")
            return 0

        def report(examined: int, expected: int) -> None:
            print(f"  examined {examined} of ~{expected}", flush=True)

        result = run_backfill(
            db,
            limit=args.limit,
            batch_size=args.batch_size,
            service=service,
            on_progress=report,
        )

    print(f"done: {result.summary()}")
    if result.skipped:
        print(
            "skipped rows are still invisible to semantic search; re-upload or "
            "re-process those documents to get vectors in this space."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
