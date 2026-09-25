from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.models.user import Role
from app.repositories.user import UserRepository
from app.routes.auth import get_current_user, pwd_context
from app.schemas.user import UserResponse

router = APIRouter(prefix="/users", tags=["users"])


class UpdateUserRequest(BaseModel):
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=20,
        pattern=r"^[a-zA-Z0-9_]+$",
        description="Username: 3-20 chars, letters/numbers/underscore only",
    )
    password: str | None = Field(
        default=None,
        min_length=8,
        description="Password must be at least 8 characters",
    )
    confirm_password: str | None = None


class UpdateRoleRequest(BaseModel):
    role: Literal["customer", "admin"]


class UpdateActiveRequest(BaseModel):
    is_active: bool


def get_current_admin(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
) -> UserResponse:
    """Like get_current_user but requires the admin role.

    The role is read from the database (not the JWT claim), so a role
    change takes effect immediately and revoked admins lose access with
    their next request.
    """
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return current_user


def _ensure_username_available(
    repo: UserRepository, request_username: str, current_user_id: UUID
) -> None:
    existing = repo.get_by_username(request_username)
    if existing is not None and existing.id != current_user_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already registered",
        )


@router.put("/me", response_model=UserResponse)
def update_current_user(
    request: UpdateUserRequest,
    current_user: Annotated[UserResponse, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Update the current user's own username and/or password.

    When changing the username, a conflict (409) is returned if another
    account already uses it. Changing the password requires an 8+ character
    value and a matching ``confirm_password``.
    """
    repo = UserRepository(db)
    update_data: dict = {}

    if request.username is not None:
        if request.username != current_user.username:
            _ensure_username_available(repo, request.username, current_user.id)
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

    user = repo.update(current_user.id, update_data)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return UserResponse.model_validate(user)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_current_user(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Permanently delete the current user's own account.

    Removes the user record (documents/chunks are cleaned up by the
    cascading relationships). The client must sign out afterwards — this
    deletes the row backing the JWT immediately.
    """
    repo = UserRepository(db)
    repo.delete(current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/", response_model=list[UserResponse])
def list_users(
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    """List every registered user (admin only)."""
    return UserRepository(db).get_all()


@router.patch("/{user_id}/role", response_model=UserResponse)
def update_user_role(
    user_id: UUID,
    request: UpdateRoleRequest,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    """Change a user's role between ``customer`` and ``admin`` (admin only).

    The role is read from the database on every request, so the change
    takes effect immediately (and revoking admin rights applies at the next
    request too).
    """
    repo = UserRepository(db)
    user = repo.get_by_id(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )

    updated = repo.update(user_id, {"role": Role(request.role)})
    return UserResponse.model_validate(updated)


@router.patch("/{user_id}/active", response_model=UserResponse)
def update_user_active(
    user_id: UUID,
    request: UpdateActiveRequest,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    """Enable or disable a user account (admin only).

    Disabled users can no longer authenticate. Deactivating your own
    account is rejected (400) to keep an admin from locking themselves out.
    """
    repo = UserRepository(db)
    user = repo.get_by_id(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    if user.id == _admin.id and not request.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot deactivate your own account",
        )

    updated = repo.update(user_id, {"is_active": request.is_active})
    return UserResponse.model_validate(updated)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    """Delete another user's account (admin only)."""
    repo = UserRepository(db)
    if repo.delete(user_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)