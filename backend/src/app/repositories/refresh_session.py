"""Queries for issued refresh tokens.

Separate from `UserRepository` because the lifecycle is the token's, not the
user's: rows here are created by login, retired by rotation, revoked by logout,
and swept by expiry. Keeping them apart means the security-relevant queries are
all in one file rather than mixed into account management.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from app.models.refresh_session import RefreshSessionDB


class RefreshSessionRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, jti: str) -> RefreshSessionDB | None:
        return self.db.get(RefreshSessionDB, jti)

    def create(
        self, jti: str, user_id: UUID, expires_at: datetime
    ) -> RefreshSessionDB:
        row = RefreshSessionDB(jti=jti, user_id=user_id, expires_at=expires_at)
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def try_retire(self, jti: str, when: datetime) -> bool:
        """Retire a still-live token, and report whether this call was the one.

        A conditional UPDATE rather than a read followed by a write: two requests
        carrying the same token can be in flight at once, and with read-then-write
        both would see the row as live and both would mint a successor. That is
        not a narrow edge case — it is the cheapest way to attack a reuse check,
        since the attacker only has to send the requests together. Matching on
        `rotated_at IS NULL AND revoked_at IS NULL` lets the database decide the
        winner, so exactly one caller gets True.
        """
        result = self.db.execute(
            update(RefreshSessionDB)
            .where(
                RefreshSessionDB.jti == jti,
                RefreshSessionDB.rotated_at.is_(None),
                RefreshSessionDB.revoked_at.is_(None),
            )
            .values(rotated_at=when)
        )
        self.db.commit()
        return bool(result.rowcount)

    def mark_revoked(self, row: RefreshSessionDB, when: datetime) -> None:
        row.revoked_at = when
        self.db.commit()

    def revoke_all_for_user(self, user_id: UUID, when: datetime) -> int:
        """Revoke every live session a user holds. Returns rows affected.

        One statement, so a user with sessions on several devices is ended in a
        single step rather than one lookup at a time. Rows already rotated or
        revoked are left alone: they cannot be presented successfully anyway, and
        rewriting their timestamps would erase the distinction between "logged
        out" and "superseded" that `begin_refresh` reports on.
        """
        result = self.db.execute(
            update(RefreshSessionDB)
            .where(
                RefreshSessionDB.user_id == user_id,
                RefreshSessionDB.revoked_at.is_(None),
                RefreshSessionDB.rotated_at.is_(None),
            )
            .values(revoked_at=when)
        )
        self.db.commit()
        return int(result.rowcount or 0)

    def delete_expired(self, now: datetime) -> int:
        """Drop rows whose token has expired anyway.

        Bounded by ``expires_at`` alone, so the sweep never has to verify a token
        to know the row is pointless.
        """
        result = self.db.execute(
            delete(RefreshSessionDB).where(RefreshSessionDB.expires_at <= now)
        )
        self.db.commit()
        return int(result.rowcount or 0)
