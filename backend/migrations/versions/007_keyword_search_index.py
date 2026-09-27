"""add a full-text index for keyword search

Revision ID: 007
Revises: 006
Create Date: 2026-09-27 00:00:00.000000

Without an embedding provider, search falls back to matching the query against
the chunk text. That fallback used to return every chunk in document order
without consulting the query at all (see #451), so no index was needed. It now
filters with `to_tsvector('english', content) @@ websearch_to_tsquery(...)` and
ranks with `ts_rank`, which without this index is a sequential scan of the whole
`document_chunks` table on every search, for every user.

The index is on the *expression* rather than a stored column, so no backfill and
no change to the insert path is required. The query must use the identical
expression to be index-eligible, which is why the repository builds it through a
single shared helper (`app.repositories.search.full_text_vector`).
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '007'
down_revision: Union[str, None] = '006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Must stay byte-identical to the expression the query uses, or Postgres will not
# use the index. The repository imports this name for the same reason.
INDEX_EXPRESSION = "to_tsvector('english', content)"
INDEX_NAME = "idx_document_chunks_content_fts"


def upgrade() -> None:
    op.execute(
        f'CREATE INDEX IF NOT EXISTS {INDEX_NAME} '
        f'ON document_chunks USING GIN ({INDEX_EXPRESSION})'
    )


def downgrade() -> None:
    op.execute(f'DROP INDEX IF EXISTS {INDEX_NAME}')
