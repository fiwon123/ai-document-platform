from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field

# Password policy.
#
# Deliberately length + blocklist rather than composition rules. NIST
# SP 800-63B advises against mandatory character-class requirements: they
# push users toward predictable substitutions ("Password1!") without
# meaningfully raising entropy. What actually matters is length, rejecting
# known-compromised values, and not allowing inputs so long they are
# silently truncated.
#
# The register page already renders an advisory strength meter (length /
# mixed case / digit / 12-char bonus) — that stays guidance, while these
# rules are the hard server-side gate.

# bcrypt hashes at most 72 bytes of input and silently discards the rest, so
# two passwords sharing a 72-byte prefix would authenticate each other. Cap
# the input instead of letting the hash quietly ignore the tail.
BCRYPT_MAX_BYTES = 72

PASSWORD_MIN_LENGTH = 8
# Generous character ceiling to reject absurd payloads early; the real limit
# is the 72-byte bcrypt boundary enforced below.
PASSWORD_MAX_LENGTH = 128

# Most-frequent passwords and obvious variants. Kept lowercase — comparison is
# case-insensitive. This is a backstop against credential stuffing and
# automated guessing, not the primary control (rate limiting is).
COMMON_PASSWORDS = frozenset(
    {
        "password",
        "password1",
        "password123",
        "passw0rd",
        "12345678",
        "123456789",
        "1234567890",
        "12345678901",
        "qwerty123",
        "qwertyuiop",
        "letmein123",
        "welcome123",
        "admin123",
        "iloveyou",
        "sunshine",
        "princess",
        "football",
        "baseball",
        "superman",
        "trustno1",
        "starwars",
        "monkey123",
        "dragon123",
        "abc12345",
        "abcd1234",
        "changeme",
        "secret123",
        "master123",
    }
)


def _validate_password_strength(password: str) -> str:
    """Reject passwords that are trivially guessable or bcrypt-truncated."""
    # bcrypt truncates on BYTES, not characters, so multi-byte scripts hit the
    # ceiling well before the character count does.
    encoded_length = len(password.encode("utf-8"))
    if encoded_length > BCRYPT_MAX_BYTES:
        raise ValueError(
            f"Password must be at most {BCRYPT_MAX_BYTES} bytes "
            "(longer passwords are truncated when hashed)"
        )

    if password.casefold() in COMMON_PASSWORDS:
        raise ValueError("Password is too common; choose something harder to guess")

    return password


Password = Annotated[
    str,
    Field(
        min_length=PASSWORD_MIN_LENGTH,
        max_length=PASSWORD_MAX_LENGTH,
        description=f"Password must be {PASSWORD_MIN_LENGTH}+ characters and not commonly used",
    ),
    AfterValidator(_validate_password_strength),
]


class CreateUserRequest(BaseModel):
    username: str = Field(
        min_length=3,
        max_length=20,
        pattern=r"^[a-zA-Z0-9_]+$",
        description="Username: 3-20 chars, letters/numbers/underscore only",
    )
    password: Password
    confirm_password: str


class UpdateUserRequest(BaseModel):
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=20,
        pattern=r"^[a-zA-Z0-9_]+$",
        description="Username: 3-20 chars, letters/numbers/underscore only",
    )
    password: Password | None = None
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
