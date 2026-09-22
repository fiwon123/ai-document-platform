"""add document thumbnail flag

Revision ID: 003
Revises: 002
Create Date: 2024-01-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Visual thumbnails are generated for PDFs during background
    # processing; the flag lets clients skip thumbnail fetches for
    # documents that can never have one.
    op.add_column(
        'documents',
        sa.Column(
            'has_thumbnail',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('false'),
        ),
    )


def downgrade() -> None:
    op.drop_column('documents', 'has_thumbnail')