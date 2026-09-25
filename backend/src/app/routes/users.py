from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.routes.auth import get_current_user
from app.schemas.user import (
    UpdateActiveRequest,
    UpdateRoleRequest,
    UpdateUserRequest,
    UserResponse,
)
from app.services.user import UserService

router = APIRouter(prefix="/users", tags=["users"])


def get_user_service(
    db: Annotated[Session, Depends(get_db)],
) -> UserService:
    return UserService.from_session(db)


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


@router.put("/me", response_model=UserResponse)
def update_current_user(
    request: UpdateUserRequest,
    current_user: Annotated[UserResponse, Depends(get_current_user)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Update the current user's own username and/or password.

    When changing the username, a conflict (409) is returned if another
    account already uses it. Changing the password requires a matching
    ``confirm_password``; strength rules are enforced by the schema.
    """
    updated = service.update_self(current_user, request)
    return UserResponse.model_validate(updated)


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
def delete_current_user(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Permanently delete the current user's own account.

    Removes the user record (documents/chunks are cleaned up by the
    cascading relationships). The client must sign out afterwards — this
    deletes the row backing the JWT immediately.
    """
    service.delete_self(current_user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/", response_model=list[UserResponse])
def list_users(
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """List every registered user (admin only)."""
    return service.list_all()


@router.patch("/{user_id}/role", response_model=UserResponse)
def update_user_role(
    user_id: UUID,
    request: UpdateRoleRequest,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Change a user's role between ``customer`` and ``admin`` (admin only).

    The role is read from the database on every request, so the change
    takes effect immediately (and revoking admin rights applies at the next
    request too).
    """
    updated = service.update_role(user_id, request)
    return UserResponse.model_validate(updated)


@router.patch("/{user_id}/active", response_model=UserResponse)
def update_user_active(
    user_id: UUID,
    request: UpdateActiveRequest,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Enable or disable a user account (admin only).

    Disabled users can no longer authenticate. Deactivating your own
    account is rejected (400) to keep an admin from locking themselves out.
    """
    updated = service.update_active(_admin.id, user_id, request)
    return UserResponse.model_validate(updated)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Delete another user's account (admin only)."""
    service.delete_user(user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
