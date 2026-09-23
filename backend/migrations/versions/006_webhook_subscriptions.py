"""webhook subscriptions table

Revision ID: 006
Revises: 005
Create Date: 2026-09-23 00:00:00.000000

Adds the webhook_subscriptions table backing the /v1/webhooks API:
users subscribe an HTTP endpoint to document lifecycle events and the
platform POSTs signed (HMAC-SHA256) notifications to it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '006'
down_revision: Union[str, None] = '005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'webhook_subscriptions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            'user_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('users.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column('url', sa.String(length=2000), nullable=False),
        sa.Column('events', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('secret', sa.String(length=64), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('last_status', sa.String(length=16), nullable=True),
        sa.Column('last_status_code', sa.Integer(), nullable=True),
        sa.Column('last_delivered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('failure_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        'ix_webhook_subscriptions_user_id',
        'webhook_subscriptions',
        ['user_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_webhook_subscriptions_user_id', table_name='webhook_subscriptions')
    op.drop_table('webhook_subscriptions')