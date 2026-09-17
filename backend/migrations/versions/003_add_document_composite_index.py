"""add composite index on documents (owner_id, created_at)

Revision ID: 003
Revises: 002
Create Date: 2024-01-03 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Serves the most common document listing query:
    #   WHERE owner_id = ? ORDER BY created_at DESC
    op.create_index(
        'ix_documents_owner_created',
        'documents',
        [sa.text('owner_id'), sa.text('created_at DESC')],
    )


def downgrade() -> None:
    op.drop_index('ix_documents_owner_created', table_name='documents')