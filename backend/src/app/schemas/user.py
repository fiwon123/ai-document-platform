from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CreateUserRequest(BaseModel):
    username: str = Field(
        min_length=3,
        max_length=20,
        pattern=r"^[a-zA-Z0-9_]+$",
        description="Username: 3-20 chars, letters/numbers/underscore only",
    )
    password: str = Field(
        min_length=8,
        description="Password must be at least 8 characters",
    )
    confirm_password: str


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


class LoginRequest(BaseModel):
    username: str
    password: str


class LogoutResponse(BaseModel):
    """Payload returned after the refresh cookie is cleared."""

    message: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105  # OAuth2 token-type literal, not a secret
    expires_in: int  # access-token lifetime in seconds (for proactive refresh)
    user: UserResponse


class UserResponse(BaseModel):
    id: UUID
    username: str
    is_active: bool
    role: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    users: list[UserResponse]

    model_config = {"from_attributes": True}
