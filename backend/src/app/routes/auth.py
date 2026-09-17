import os
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    status,
)
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.user import UserRepository
from app.schemas.user import (
    CreateUserRequest,
    LogoutResponse,
    TokenResponse,
    UserResponse,
)

SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable must be set")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

# Refresh tokens live in an httpOnly cookie scoped to the refresh endpoint.
# The browser never exposes them to JavaScript, and the cookie is only sent
# back on /v1/auth/refresh — never on API or static requests.
REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/v1/auth/refresh"
REFRESH_COOKIE_SECURE = os.getenv("REFRESH_COOKIE_SECURE", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_bearer = OAuth2PasswordBearer(tokenUrl="/v1/auth/login")

router = APIRouter(prefix="/auth", tags=["auth"])


def create_access_token(user_id: str, username: str, role: str) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    encode = {
        "sub": username,
        "id": user_id,
        "role": role,
        "type": "access",
        "exp": expire,
    }
    return jwt.encode(encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(user_id: str, username: str, role: str) -> str:
    """Long-lived token (default 7 days) that can only mint new access tokens.

    Includes a unique ``jti`` claim so every issuance is distinct — required
    for rotation to be meaningful (a fresh token is never byte-identical to
    the previous one) and ready for server-side revocation later.
    """
    from uuid import uuid4

    expire = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    encode = {
        "sub": username,
        "id": user_id,
        "role": role,
        "type": "refresh",
        "jti": uuid4().hex,
        "exp": expire,
    }
    return jwt.encode(encode, SECRET_KEY, algorithm=ALGORITHM)


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=REFRESH_COOKIE_SECURE,
        samesite="lax",
        path=REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    # Mirror every attribute of _set_refresh_cookie: some browsers only
    # delete a cookie when the clearing response matches the original
    # path, Secure, and SameSite attributes.
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        secure=REFRESH_COOKIE_SECURE,
        samesite="lax",
        httponly=True,
    )


def get_current_user(
    token: Annotated[str, Depends(oauth2_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: str | None = payload.get("id")
        if user_id is None:
            raise credentials_exception
        # Refresh tokens are long-lived bearer-grade credentials and must
        # never be accepted as access tokens on API endpoints. Tokens minted
        # before the type claim existed carry no "type" — treat those as
        # access tokens so old sessions keep working.
        if payload.get("type") == "refresh":
            raise credentials_exception
    except JWTError:
        raise credentials_exception from None

    repo = UserRepository(db)
    user = repo.get_by_id(UUID(user_id))
    if user is None or not user.is_active:
        raise credentials_exception

    return UserResponse.model_validate(user)


def get_current_user_id(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
) -> UUID:
    return current_user.id


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
def register(
    request: CreateUserRequest,
    db: Annotated[Session, Depends(get_db)],
):
    repo = UserRepository(db)

    if request.password != request.confirm_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Passwords do not match",
        )

    existing = repo.get_by_username(request.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already registered",
        )

    user = repo.create(
        username=request.username,
        hashed_password=pwd_context.hash(request.password),
    )

    return UserResponse.model_validate(user)


@router.post("/login", response_model=TokenResponse)
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
):
    repo = UserRepository(db)
    user = repo.get_by_username(form_data.username)

    if user is None or not pwd_context.verify(form_data.password, user.hashed_password):
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

    role = user.role.value if user.role else "customer"
    token = create_access_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )

    refresh_token = create_refresh_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    _set_refresh_cookie(response, refresh_token)

    return TokenResponse(
        access_token=token,
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse.model_validate(user),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh_access_token(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
):
    """Exchange a valid refresh cookie for a fresh access token.

    Tokens are rotated on every refresh: a new refresh token (with a fresh
    ``jti``) replaces the cookie value, so the old one can never be replayed
    in subsequent refreshes. A stolen cookie is limited to the 7-day window
    of a single token; server-side revocation can later key off the ``jti``.
    """
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing refresh token",
        )

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            raise JWTError("Not a refresh token")
        user_id = UUID(payload.get("id", ""))
    except (JWTError, ValueError, TypeError):
        # Garbage, expired, malformed, or abused token — clear the cookie
        # and re-auth from scratch.
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        ) from None

    repo = UserRepository(db)
    user = repo.get_by_id(user_id)
    if user is None or not user.is_active:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    role = user.role.value if user.role else "customer"
    access_token = create_access_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    new_refresh_token = create_refresh_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    _set_refresh_cookie(response, new_refresh_token)

    return TokenResponse(
        access_token=access_token,
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse.model_validate(user),
    )


@router.post("/logout", response_model=LogoutResponse)
def logout(response: Response):
    """Clear the httpOnly refresh cookie (client JS cannot read it)."""
    _clear_refresh_cookie(response)
    return LogoutResponse(message="Logged out successfully")


@router.get("/me", response_model=UserResponse)
def read_current_user(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
):
    return current_user
