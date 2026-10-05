"""Server-side record of issued refresh tokens.

A refresh token is a signed JWT, so it can be *read* by anyone holding it and
*verified* by this service — but a stateless token cannot be taken back. That
matters for two documented behaviours:

* rotation is supposed to mean a retired token cannot be replayed
  (``/v1/auth/refresh``), and
* logout is supposed to revoke the refresh token (see ``AGENTS.md``).

Neither is enforceable without server-side state, and the ``jti`` claim that
every refresh token already carries is the natural key for it. This table is that
state: one row per issued token, so a rotation retires the row it consumed and
logout marks the presented one revoked.

Deliberately *not* a cache. A flushed cache would silently resurrect every stolen
refresh token, which is the one outcome the table exists to prevent.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RefreshSessionDB(Base):
    """One issued refresh token, tracked so it can be retired or revoked."""

    __tablename__ = "refresh_sessions"

    # The token's own `jti`, so no lookup key has to be invented alongside it.
    jti: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # When the row may be forgotten: the token's own `exp`. Kept so a sweep has a
    # bound that needs no token to verify.
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # Set when this token is exchanged for its successor. A presented token that
    # is already rotated is a replay, because the client only ever holds the
    # newest one.
    rotated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set by logout. Kept separate from `rotated_at` so "the user logged out" stays
    # distinguishable from "this token was superseded".
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


# The expiry sweep in `app.services.auth` walks by `expires_at`, which is the one
# query that reads a range. `user_id` is indexed for the other direction: the
# cascade above has to find a deleted account's rows, and without this that is a
# sequential scan of the whole table on every account deletion.
Index("ix_refresh_sessions_user_id", RefreshSessionDB.user_id)
Index("ix_refresh_sessions_expires_at", RefreshSessionDB.expires_at)
