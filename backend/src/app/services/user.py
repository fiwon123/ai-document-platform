"""User domain business logic: registration, credentials, and account admin.

Sits between the auth/users routes and ``UserRepository``. Owns the bcrypt
hashing context so password handling lives in exactly one place — the routes
import it from here rather than each other, which also keeps the dependency
arrow pointing route → service → repository.
"""

from uuid import UUID

from fastapi import HTTPException, status
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.models.user import Role, UserDB
from app.repositories.user import UserRepository
from app.schemas.user import UpdateActiveRequest, UpdateRoleRequest, UpdateUserRequest

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class UserService:
    def __init__(self, repository: UserRepository):
        self.repo = repository

    @classmethod
    def from_session(cls, db: Session) -> UserService:
        """Build a service bound to a request-scoped session."""
        return cls(repository=UserRepository(db))

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
        """Update the caller's own username and/or password."""
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

    def delete_self(self, current_user_id: UUID) -> None:
        """Permanently delete the caller's account.

        Related documents, chunks, and webhook subscriptions are removed by the
        cascading relationships on the model. The client must sign out
        afterwards — this drops the row backing the JWT immediately.
        """
        self.repo.delete(current_user_id)

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
        """Delete another user's account."""
        if self.repo.delete(user_id) is None:
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
