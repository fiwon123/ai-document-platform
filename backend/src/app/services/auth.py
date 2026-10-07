"""Server-side enforcement of refresh-token rotation and revocation.

A refresh token is a signed JWT, so the service can read and verify it but cannot
take it back. Three documented behaviours need exactly that:

* rotation, so a retired token cannot be replayed (`/v1/auth/refresh`),
* logout, documented in `AGENTS.md` as "Revoke refresh token", and
* a bounded number of live sessions per user.

`RefreshSessionDB` holds the state that makes them enforceable. This service owns
the *decision* — which is the part worth isolating, because "is this token
retired, revoked, or merely old" is a security question, and the answer decides
whether a session continues.

Refusing is always the safe answer: every rejection path returns 401, and nothing
here ever extends a session's life.
"""

import enum
import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.refresh_session import RefreshSessionDB
from app.repositories.refresh_session import RefreshSessionRepository

logger = logging.getLogger(__name__)


class RefreshOutcome(enum.Enum):
    """What a presented refresh token's `jti` turned out to be.

    Only `ROTATED` and `ADOPTED` may mint a new token. The two rejections are
    distinct because they mean different things to an operator: a revoked token
    is a user who logged out, while a replay is a token that has already been
    spent — which is what a stolen copy looks like.
    """

    #: Live token, exchanged for a successor. The presented one is now retired.
    ROTATED = "rotated"
    #: No row: a valid, unexpired token issued before this table existed. Adopted
    #: — and retired like any rotation — so deploying this does not sign every
    #: current user out, and an adopted token is not replayable either.
    ADOPTED = "adopted"
    #: Already spent — the client only ever holds the newest token, so a second
    #: presentation is a replay rather than a refresh.
    REPLAY = "replay"
    #: Revoked by logout.
    REVOKED = "revoked"


class RefreshSessionService:
    def __init__(self, repository: RefreshSessionRepository):
        self.repo = repository

    @classmethod
    def from_session(cls, db: Session) -> RefreshSessionService:
        return cls(RefreshSessionRepository(db))

    def record_issue(self, jti: str, user_id: UUID, expires_at: datetime) -> RefreshSessionDB:
        """Track a token handed out at login, and return its row."""
        return self.repo.create(jti, user_id, expires_at)

    def begin_refresh(self, jti: str, user_id: UUID, expires_at: datetime) -> RefreshOutcome:
        """Decide whether `jti` may be exchanged, retiring it when it may.

        `expires_at` is the token's own `exp`, which the route has already
        verified, so an expired token never reaches here — this is the value to
        store for a row whose token is being adopted.

        Only ROTATED and ADOPTED let the caller mint a successor. The refusal is
        one-way: no branch here clears `rotated_at` or `revoked_at`, so a spent
        token stays spent for the rest of its life.
        """
        now = datetime.now(UTC)

        if self.repo.get(jti) is None:
            return self._adopt(jti, user_id, expires_at, now)

        if self.repo.try_retire(jti, now):
            return RefreshOutcome.ROTATED

        # The conditional update matched nothing, so the row exists but is no
        # longer live. Re-read it to say which of the two it was: a token that
        # was both logged out and replayed is reported as the logout it was.
        row = self.repo.get(jti)
        if row is not None and row.revoked_at is not None:
            logger.warning("Refresh token replayed after logout for user %s", row.user_id)
            return RefreshOutcome.REVOKED

        logger.warning("Spent refresh token replayed for user %s", user_id)
        return RefreshOutcome.REPLAY

    def _adopt(
        self, jti: str, user_id: UUID, expires_at: datetime, now: datetime
    ) -> RefreshOutcome:
        """Track a valid token issued before this table existed, and retire it.

        Adopted rather than refused so that applying the migration does not sign
        out everyone holding an unexpired token, and retired just as a rotation
        is, so an adopted token is not the one kind that can be replayed.
        """
        try:
            self.record_issue(jti, user_id, expires_at)
        except IntegrityError:
            # Another request adopted the same token between the lookup above and
            # this insert. It got there first, so this caller is the replay.
            self.repo.db.rollback()
            logger.info("Refresh token adopted concurrently for user %s; refusing", user_id)
            return RefreshOutcome.REPLAY

        self.repo.try_retire(jti, now)
        logger.info("Adopted pre-existing refresh token for user %s", user_id)
        return RefreshOutcome.ADOPTED

    def revoke(self, jti: str) -> bool:
        """Revoke the presented session. Returns whether a row was found.

        A token with no row is not an error at logout: the token may predate this
        table, in which case there is nothing stored to revoke, and refusing to
        log anyone out because of a bookkeeping gap would be worse than the gap.
        """
        row = self.repo.get(jti)
        if row is None:
            return False
        if row.revoked_at is None:
            self.repo.mark_revoked(row, datetime.now(UTC))
        return True

    def revoke_all_for_user(self, user_id: UUID) -> int:
        """End every live session a user holds. Returns how many were ended.

        Used when a password changes. The user's own session goes with the rest:
        the refresh cookie is scoped to `/v1/auth`, so the request that changes a
        password does not carry it and the server cannot tell which session is
        making the change. Ending all of them is both the safe reading of "I think
        this account is compromised" and the only one that needs no way to
        identify the caller.
        """
        removed = self.repo.revoke_all_for_user(user_id, datetime.now(UTC))
        if removed:
            logger.info("Revoked %s refresh session(s) for user %s", removed, user_id)
        return removed

    def sweep_expired(self) -> int:
        """Forget tokens that have expired. Returns rows removed."""
        removed = self.repo.delete_expired(datetime.now(UTC))
        if removed:
            logger.info("Swept %s expired refresh session(s)", removed)
        return removed
