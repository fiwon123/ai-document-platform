"""add composite index on documents (owner_id, created_at)

Revision ID: 004
Revises: 003
Create Date: 2026-09-22 00:00:00.000000

Speeds up the common per-user document list query
(WHERE owner_id = ? ORDER BY created_at DESC LIMIT n) — PostgreSQL serves
the DESC ordering with a backward scan of this composite index, instead of
relying on the single-column owner_id index alone.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = 'ix_documents_owner_id_created_at'


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        'documents',
        ['owner_id', 'created_at'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name='documents')