"""User domain business logic: registration, credentials, and account admin.

Sits between the auth/users routes and ``UserRepository``. Owns the bcrypt
hashing context so password handling lives in exactly one place — the routes
import it from here rather than each other, which also keeps the dependency
arrow pointing route → service → repository.
"""

import logging
from uuid import UUID

from fastapi import HTTPException, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.models.user import Role, UserDB
from app.repositories.user import UserRepository
from app.schemas.user import UpdateActiveRequest, UpdateRoleRequest, UpdateUserRequest
from app.services.auth import RefreshSessionService
from app.services.thumbnail import thumbnail_object_key
from app.storage.storage import MinioStorage
from app.storage.storage import storage as default_storage

logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class UserService:
    def __init__(
        self,
        repository: UserRepository,
        storage: MinioStorage | None = None,
        sessions: RefreshSessionService | None = None,
    ):
        self.repo = repository
        # Optional so the many tests that exercise the user endpoints without
        # object storage keep working unchanged. When it is absent, rows are
        # still cascaded by the database; only the uploaded files are left in
        # the bucket, which is why `from_session` always supplies one.
        self.storage = storage
        # Optional for the same reason as storage: tests that build this service
        # by hand should not have to know about refresh sessions to update a
        # username. `from_session` always supplies one, which is what makes
        # "changing a password ends the sessions" true in the running app.
        self.sessions = sessions

    @classmethod
    def from_session(cls, db: Session) -> UserService:
        """Build a service bound to a request-scoped session.

        Uses the shared storage singleton rather than a fresh client: boto3
        clients hold a connection pool and are not cheap to build, so making one
        per request would leak a pool per request for the life of the process.
        This is the same instance the document service is given.
        """
        return cls(
            repository=UserRepository(db),
            storage=default_storage,
            # Same `db`, so the session rows and the user row are written in one
            # transaction and cannot drift apart.
            sessions=RefreshSessionService.from_session(db),
        )

    # --- lookups -----------------------------------------------------------

    def get_active_by_id(self, user_id: UUID) -> UserDB | None:
        """Return the user only if it exists and is enabled.

        Used by the auth dependencies and the refresh rotation, which must
        reject a user disabled after the token was minted. Returns ``None``
        rather than raising so callers can raise their own 401 with the
        response handling (cookie clearing) they need.
        """
        user = self.repo.get_by_id(user_id)
        if user is None or not user.is_active:
            return None
        return user

    # --- registration / authentication -------------------------------------

    def register(self, username: str, password: str, confirm_password: str) -> UserDB:
        """Create an account, rejecting mismatched or weak confirmations.

        Password strength itself is enforced by the request schema; this layer
        owns the cross-field confirmation and uniqueness checks.
        """
        if password != confirm_password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Passwords do not match",
            )

        if self.repo.get_by_username(username) is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already registered",
            )

        return self.repo.create(
            username=username,
            hashed_password=pwd_context.hash(password),
        )

    def authenticate(self, username: str, password: str) -> UserDB:
        """Return the user for valid credentials.

        The same message is used for an unknown username and a wrong password
        so the endpoint does not disclose which accounts exist.
        """
        user = self.repo.get_by_username(username)
        if user is None or not pwd_context.verify(password, user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect username or password",
                headers={"WWW-Authenticate": "Bearer"},
            )

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account is disabled",
            )

        return user

    # --- self-service ------------------------------------------------------

    def update_self(
        self, current_user: UserDB, request: UpdateUserRequest
    ) -> UserDB:
        """Update the caller's own username and/or password.

        A password change also ends every refresh session the account holds.
        Changing a password is what a user does when they think an account is
        compromised, and without this the attacker's refresh cookie keeps minting
        access tokens for the rest of its 7-day life while the user sits there
        locked out of their own account. A username change revokes nothing: it is
        not a credential, and it is a normal thing to do.

        Sessions are revoked *before* the new hash is written, so a failure in
        between leaves the user logged out rather than logged in under a password
        they believe they have just secured. The uncomfortable direction is the
        only safe one to fail in.
        """
        update_data: dict = {}

        if request.username is not None:
            if request.username != current_user.username:
                self._ensure_username_available(
                    request.username, current_user.id
                )
            update_data["username"] = request.username

        if request.password is not None:
            if request.confirm_password != request.password:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Passwords do not match",
                )
            # Before `repo.update`, which commits: see the docstring.
            if self.sessions is not None:
                self.sessions.revoke_all_for_user(current_user.id)
            update_data["hashed_password"] = pwd_context.hash(request.password)

        if not update_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Nothing to update",
            )

        user = self.repo.update(current_user.id, update_data)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )
        return user

    def _delete_account(self, user_id: UUID):
        """Delete the account and everything that belongs to it.

        Returns the deleted `UserDB`, or `None` if there was no such account —
        taken from the single `DELETE` itself rather than a preceding lookup, so
        a caller cannot observe an account that has already gone.

        The rows go first and unconditionally, because the database cascades
        them: documents, their chunks, search history and webhook
        subscriptions are all removed by the `ON DELETE CASCADE` constraints
        added in migration 009, so erasure does not depend on this method
        remembering to clean each table.

        The stored objects are then removed on a best-effort basis, and the
        order matters. The keys have to be read *before* the delete, because
        afterwards the document rows that named them are gone; and the delete
        must not depend on the object store answering, or a MinIO outage would
        leave someone unable to delete their own account. A failed object
        removal is logged with the key rather than swallowed: the row is gone,
        so the object is now unreachable through the API but is still a file
        sitting in the bucket, and that is worth an operator's attention.
        """
        object_keys = self.repo.list_object_keys(user_id)
        deleted = self.repo.delete(user_id)
        if deleted is None or self.storage is None:
            return deleted
        for object_key in object_keys:
            try:
                self.storage.delete(object_key)
                # The thumbnail lives beside the document, so a document delete
                # removes it too; skipping it here would leak one PNG per
                # document for the lifetime of the bucket.
                self.storage.delete(thumbnail_object_key(object_key))
            except Exception as e:  # noqa: BLE001 - the account row is already gone
                logger.warning(
                    f"Object cleanup failed for {object_key} during account "
                    f"deletion: {e}. The database rows are deleted; this object "
                    f"remains in the bucket and should be removed manually."
                )
        return deleted

    def delete_self(self, current_user_id: UUID) -> None:
        """Permanently delete the caller's account.

        Guaranteed by the database, not by this method: `documents`,
        `document_chunks`, `search_history` and `webhook_subscriptions` all
        carry `ON DELETE CASCADE` to `users`, and `document_chunks` cascades
        from `documents` in turn. Uploaded files and their thumbnails are
        removed from object storage on a best-effort basis — see
        `_delete_account` for why it is not part of the guarantee.

        The client must sign out afterwards — this drops the row backing the
        JWT immediately.
        """
        self._delete_account(current_user_id)

    # --- admin operations --------------------------------------------------

    def list_all(self) -> list[UserDB]:
        """List every registered user."""
        return self.repo.get_all()

    def update_role(self, user_id: UUID, request: UpdateRoleRequest) -> UserDB:
        """Change a user's role between ``customer`` and ``admin``."""
        self._get_or_404(user_id)
        return self.repo.update(user_id, {"role": Role(request.role)})

    def update_active(
        self, admin_id: UUID, user_id: UUID, request: UpdateActiveRequest
    ) -> UserDB:
        """Enable or disable an account.

        Disabled users can no longer authenticate. Deactivating your own
        account is rejected so an admin cannot lock themselves out.
        """
        user = self._get_or_404(user_id)

        if user.id == admin_id and not request.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot deactivate your own account",
            )

        return self.repo.update(user_id, {"is_active": request.is_active})

    def delete_user(self, user_id: UUID) -> None:
        """Delete another user's account.

        Same guarantee and same storage handling as `delete_self`; an admin
        removing an account must not leave a weaker trail than the owner
        removing their own.
        """
        if self._delete_account(user_id) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

    # --- internals ---------------------------------------------------------

    def _get_or_404(self, user_id: UUID) -> UserDB:
        user = self.repo.get_by_id(user_id)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )
        return user

    def _ensure_username_available(
        self, request_username: str, current_user_id: UUID
    ) -> None:
        existing = self.repo.get_by_username(request_username)
        if existing is not None and existing.id != current_user_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already registered",
            )
