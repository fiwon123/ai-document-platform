"""align models with database schema (timestamps tz, is_active NOT NULL)

Revision ID: 005
Revises: 004
Create Date: 2026-09-22 00:00:00.000000

Resolves model/DB drift found by ``alembic revision --autogenerate``:
- documents.created_at / updated_at: TIMESTAMP WITHOUT TIME ZONE ->
  TIMESTAMP WITH TIME ZONE (all other tables already use tz-aware)
- users.is_active: nullable -> NOT NULL (inserts always set it; verified
  zero NULL rows before applying)

The ivfflat embedding index (idx_document_chunks_embedding) is created via
raw SQL in migration 002 and already exists in the database; the model-side
declaration added in this change restores autogenerate/create_all parity and
needs no DDL here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '005'
down_revision: Union[str, None] = '004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Any legacy rows with NULL is_active would block the NOT NULL alter;
    # inserts always set it (Python default True), so backfill defensively
    # for databases that predate the default.
    op.execute(sa.text("UPDATE users SET is_active = true WHERE is_active IS NULL"))

    # TIMESTAMP -> TIMESTAMPTZ rewrites the table (ACCESS EXCLUSIVE lock;
    # acceptable at current scale). Pre-005 code wrote UTC datetimes into
    # the naive column, so pin the interpretation explicitly instead of
    # letting PostgreSQL apply the session TimeZone.
    op.alter_column(
        'documents',
        'created_at',
        existing_type=sa.DateTime(timezone=False),
        type_=sa.DateTime(timezone=True),
        existing_nullable=False,
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )
    op.alter_column(
        'documents',
        'updated_at',
        existing_type=sa.DateTime(timezone=False),
        type_=sa.DateTime(timezone=True),
        existing_nullable=False,
        postgresql_using="updated_at AT TIME ZONE 'UTC'",
    )
    op.alter_column(
        'users',
        'is_active',
        existing_type=sa.BOOLEAN(),
        existing_nullable=True,
        nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        'users',
        'is_active',
        existing_type=sa.BOOLEAN(),
        nullable=True,
    )
    op.alter_column(
        'documents',
        'updated_at',
        existing_type=sa.DateTime(timezone=True),
        type_=sa.DateTime(timezone=False),
        existing_nullable=False,
    )
    op.alter_column(
        'documents',
        'created_at',
        existing_type=sa.DateTime(timezone=True),
        type_=sa.DateTime(timezone=False),
        existing_nullable=False,
    )
