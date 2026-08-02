import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class CreateUserRequest(BaseModel):
    username: str = Field(
        min_length=3,
        max_length=20,
        pattern=r"^[a-zA-Z0-9_]+$",
        description="Username: 3–20 chars, letters/numbers/underscore only"
    )
    password: str = Field(
        min_length=8,
        description="Password must be at least 8 characters"
    )
    confirm_password: str

    model_config = {
        "json_schema_extra": {
            "example": {
                "username": "john_doe",
                "password": "securepass123",
                "confirm_password": "securepass123"
            }
        }
    }


class UserResponse(BaseModel):
    id: UUID
    username: str
    is_active: bool
    role: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}
