"""add the local embedding space

Revision ID: 008
Revises: 007
Create Date: 2026-09-28 00:00:00.000000

The local provider's vectors are a different width from OpenAI's 1536 and
pgvector cannot index a column of mixed widths, so they get their own column
rather than sharing one. See `app.models.chunk` for the three measured
refusals that make this the only workable layout.

Two things here are deliberately *not* done:

- `embedding` is left at vector(1536) and keeps its ivfflat index, so a
  deployment with an OpenAI key is untouched by this migration.
- The 523 chunks written before this column existed keep their vectors and
  their `embedding_model` stays NULL. They are not relabelled with a guess:
  the model that produced them is not recorded anywhere, and asserting
  `text-embedding-ada-002` for all of them would silently mislabel a
  deployment that configured something else. A NULL row is excluded from
  vector search, which is a visible, recoverable state (re-embed the
  document) rather than a wrong ranking nobody can detect.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

# revision identifiers, used by Alembic.
revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Unconstrained width: nomic-embed-text is 768, mxbai-embed-large 1024,
    # all-minilm 384, and the operator picks the model.
    op.add_column(
        "document_chunks",
        sa.Column("embedding_local", Vector(), nullable=True),
    )
    op.add_column(
        "document_chunks",
        sa.Column("embedding_model", sa.String(length=255), nullable=True),
    )
    # Every vector search filters on embedding_model, and it is as selective as
    # the filter gets (one model per deployment), so it is indexed in its own
    # right rather than only as a filter the planner has to scan for.
    op.create_index(
        "ix_document_chunks_embedding_model",
        "document_chunks",
        ["embedding_model"],
    )
    # A chunk is embedded once, by one model, in one space. Enforced by the
    # database so it holds for every writer — the worker's insert path today,
    # and whatever writes next.
    op.create_check_constraint(
        "ck_document_chunks_single_embedding_space",
        "document_chunks",
        "embedding IS NULL OR embedding_local IS NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_document_chunks_single_embedding_space",
        "document_chunks",
        type_="check",
    )
    op.drop_index("ix_document_chunks_embedding_model", table_name="document_chunks")
    op.drop_column("document_chunks", "embedding_model")
    op.drop_column("document_chunks", "embedding_local")
