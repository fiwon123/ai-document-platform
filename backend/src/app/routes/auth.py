import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID, uuid4

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
from sqlalchemy.orm import Session

from app.config import ensure_secret_key_acceptable
from app.database.db import get_db
from app.schemas.user import (
    CreateUserRequest,
    LogoutResponse,
    TokenResponse,
    UserResponse,
)
from app.services.auth import RefreshOutcome, RefreshSessionService
from app.services.user import UserService

# Guarded at import time as well as in the startup lifespan: this module can be
# imported without the app ever starting (a script, a test, the worker's import
# chain), and it signs and verifies every token it touches. See app.config for
# why the rule is defined there rather than duplicated here.
ensure_secret_key_acceptable(os.getenv("SECRET_KEY", ""))
SECRET_KEY = os.getenv("SECRET_KEY", "")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

logger = logging.getLogger(__name__)

# Refresh tokens live in an httpOnly cookie, so the browser never exposes them to
# JavaScript, and it is only ever sent back to the auth routes below — never on
# document, search or QA requests.
REFRESH_COOKIE_NAME = "refresh_token"
# Scoped to the auth routes, and *not* to /v1/auth/refresh alone: a browser sends
# a cookie only to paths at or below its own, so the narrower scope meant
# /v1/auth/logout never received the token and could not revoke the very thing it
# was asked to revoke.
REFRESH_COOKIE_PATH = "/v1/auth"
REFRESH_COOKIE_SECURE = os.getenv("REFRESH_COOKIE_SECURE", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}

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


@dataclass(frozen=True)
class IssuedRefreshToken:
    """A refresh token plus the two claims the session store needs.

    Returned rather than just the string because the `jti` has to be recorded at
    the moment of issuance, and decoding the token back out to recover it would
    make the caller verify a token it had just created.
    """

    token: str
    jti: str
    expires_at: datetime


def create_refresh_token(user_id: str, username: str, role: str) -> IssuedRefreshToken:
    """Long-lived token (default 7 days) that can only mint new access tokens.

    The unique ``jti`` claim is what makes rotation enforceable: it is the primary
    key of `refresh_sessions`, so the store can tell a spent token from the live
    one. That is no longer aspirational — `RefreshSessionService` retires the row
    on every refresh and refuses it afterwards.
    """
    jti = uuid4().hex
    expire = datetime.now(UTC) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    encode = {
        "sub": username,
        "id": user_id,
        "role": role,
        "type": "refresh",
        "jti": jti,
        "exp": expire,
    }
    return IssuedRefreshToken(
        token=jwt.encode(encode, SECRET_KEY, algorithm=ALGORITHM),
        jti=jti,
        expires_at=expire,
    )


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

    user = UserService.from_session(db).get_active_by_id(UUID(user_id))
    if user is None:
        raise credentials_exception

    return UserResponse.model_validate(user)


def get_current_user_id(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
) -> UUID:
    return current_user.id


def get_user_service(
    db: Annotated[Session, Depends(get_db)],
) -> UserService:
    return UserService.from_session(db)


def get_refresh_session_service(
    db: Annotated[Session, Depends(get_db)],
) -> RefreshSessionService:
    return RefreshSessionService.from_session(db)


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
def register(
    request: CreateUserRequest,
    service: Annotated[UserService, Depends(get_user_service)],
):
    """Create a new user account.

    Validates that the password confirmation matches and that the username
    is not already taken, then stores a bcrypt-hashed password. Returns the
    created user (credentials are not issued here — call ``/v1/auth/login``).
    """
    user = service.register(
        username=request.username,
        password=request.password,
        confirm_password=request.confirm_password,
    )
    return UserResponse.model_validate(user)


@router.post("/login", response_model=TokenResponse)
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    response: Response,
    service: Annotated[UserService, Depends(get_user_service)],
    sessions: Annotated[RefreshSessionService, Depends(get_refresh_session_service)],
):
    """Exchange credentials for a Bearer access token.

    Accepts the OAuth2 password flow (``application/x-www-form-urlencoded``
    with ``username``/``password``). On success, a refresh token is set as an
    httpOnly cookie scoped to the auth routes and an access token plus the user
    profile are returned in the body.

    The session is recorded at issuance, not at first refresh, because the store
    has to know a token exists before anything can be revoked. A login that
    recorded nothing would hand out a token no logout could ever reach.
    """
    user = service.authenticate(form_data.username, form_data.password)

    role = user.role.value if user.role else "customer"
    token = create_access_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )

    issued = create_refresh_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    sessions.record_issue(issued.jti, user.id, issued.expires_at)
    _set_refresh_cookie(response, issued.token)

    return TokenResponse(
        access_token=token,
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse.model_validate(user),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh_access_token(
    request: Request,
    response: Response,
    service: Annotated[UserService, Depends(get_user_service)],
    sessions: Annotated[RefreshSessionService, Depends(get_refresh_session_service)],
):
    """Exchange a valid refresh cookie for a fresh access token.

    Tokens are rotated on every refresh: a new refresh token (with a fresh
    ``jti``) replaces the cookie value and the presented ``jti`` is retired in
    ``refresh_sessions``. Presenting a retired one is therefore refused with 401,
    which is what makes rotation mean anything — previously a retired token was
    accepted and minted another token, so rotation rotated nothing away from
    anyone holding a copy.

    A valid, unexpired token with no stored session is *adopted* rather than
    refused, so deploying this does not sign out everyone who logged in before it.

    A stolen token is bounded to its own 7-day window, but detecting the reuse
    and revoking the rest of the session chain is a separate policy decision, not
    something to assume here.
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
        jti = str(payload.get("jti", ""))
        expires_at = datetime.fromtimestamp(payload["exp"], tz=UTC)
    except (JWTError, ValueError, TypeError, KeyError):
        # Garbage, expired, malformed, or abused token — clear the cookie
        # and re-auth from scratch.
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        ) from None

    if not jti:
        # A token signed by this service always carries a `jti`, so its absence
        # means the token did not come from here. Refuse rather than adopt.
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    user = service.get_active_by_id(user_id)
    if user is None:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    outcome = sessions.begin_refresh(jti, user.id, expires_at)
    if outcome in (RefreshOutcome.REPLAY, RefreshOutcome.REVOKED):
        # The client only ever holds the newest token, so a spent or revoked one
        # arriving here means a copy is in circulation. Refuse and clear the
        # cookie so the browser stops presenting it.
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token is no longer valid",
        )

    role = user.role.value if user.role else "customer"
    access_token = create_access_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    issued = create_refresh_token(
        user_id=str(user.id),
        username=user.username,
        role=role,
    )
    sessions.record_issue(issued.jti, user.id, issued.expires_at)
    _set_refresh_cookie(response, issued.token)

    return TokenResponse(
        access_token=access_token,
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse.model_validate(user),
    )


@router.post("/logout", response_model=LogoutResponse)
def logout(
    request: Request,
    response: Response,
    sessions: Annotated[RefreshSessionService, Depends(get_refresh_session_service)],
):
    """Revoke the current refresh token and clear its cookie.

    Clearing the cookie alone is not logging out: the token stays valid until it
    expires, so anything holding a copy — a backup, a proxy log, a shared machine
    that kept the value — could keep minting access tokens for the rest of its
    7-day life. `AGENTS.md` documents this endpoint as "Revoke refresh token",
    which is what it now does.

    Only the *presented* session is revoked, which is the contract: logging out
    of one browser should not sign the user out of their phone. Revoking every
    session for a user is a separate, explicitly-named operation.

    Idempotent by design. A missing, malformed, or already-revoked cookie is not
    an error — there is nothing left to revoke, and refusing to acknowledge a
    logout would leave the user unsure whether they are still signed in. An
    unparseable token is still worth logging, since it is the only trace of it.
    """
    _clear_refresh_cookie(response)

    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        return LogoutResponse(message="Logged out successfully")

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            raise JWTError("Not a refresh token")
        jti = str(payload.get("jti", ""))
    except (JWTError, ValueError, TypeError):
        logger.info("Logout presented an unreadable refresh token; nothing to revoke")
        return LogoutResponse(message="Logged out successfully")

    if jti and sessions.revoke(jti):
        logger.info("Revoked refresh session %s on logout", jti)
    return LogoutResponse(message="Logged out successfully")


@router.get("/me", response_model=UserResponse)
def read_current_user(
    current_user: Annotated[UserResponse, Depends(get_current_user)],
):
    """Return the profile of the currently authenticated user."""
    return current_user
