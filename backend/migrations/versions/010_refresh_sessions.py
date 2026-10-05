"""track issued refresh tokens so rotation and logout can be enforced

Revision ID: 010
Revises: 009
Create Date: 2026-09-28 00:00:00.000000

`POST /v1/auth/refresh` rotated its token and documented that the old one "can
never be replayed"; `POST /v1/auth/logout` is documented in `AGENTS.md` as
"Revoke refresh token". Neither was true, because a refresh token is a stateless
JWT: the `jti` claim is minted on every issuance and then read by nothing.

Confirmed against the API. Replaying a retired refresh token returned 200 and
minted another token, and a refresh token still worked after logout (#516).

The schema is what makes the guarantee enforceable, for the same reason migration
009 put user deletion in the database rather than in the service: a rule a
routine has to remember is not a rule. A stateless token can be read and verified
but not taken back, so the state has to live somewhere — and it must not be a
cache, since a flushed cache would silently resurrect every stolen token, which
is the one outcome the table exists to prevent.

`jti` is the primary key, so the table is the token's own identifier and the
service needs no second scheme for naming rows. The two timestamps answer
different questions on purpose: `rotated_at` means "superseded by a successor,
so seeing it again is a replay", while `revoked_at` means "the user logged out",
which is a statement about the session rather than about a single token.

No rows are created here. Every token issued before this migration has no row and
is adopted on first use, so applying the migration does not sign anyone out.

The foreign key cascades, matching 009: an account's sessions are part of the
account, and a row whose user no longer exists cannot be presented for anything.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "refresh_sessions",
        sa.Column("jti", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("jti"),
    )
    # The expiry sweep walks by `expires_at`; `user_id` serves the cascade, which
    # otherwise has to scan this table for every account deletion.
    op.create_index(
        "ix_refresh_sessions_user_id", "refresh_sessions", ["user_id"]
    )
    op.create_index(
        "ix_refresh_sessions_expires_at", "refresh_sessions", ["expires_at"]
    )


def downgrade() -> None:
    # Dropped index-first, matching 009's ordering: the indexes exist only to
    # serve this table, so there is nothing to preserve by leaving them.
    op.drop_index("ix_refresh_sessions_expires_at", table_name="refresh_sessions")
    op.drop_index("ix_refresh_sessions_user_id", table_name="refresh_sessions")
    op.drop_table("refresh_sessions")
