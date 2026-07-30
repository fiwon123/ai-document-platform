import os
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt

admin = {
    "id": "1",
    "name": "admin",
    "username": "admin",
    "password": "admin",
    "role": "admin",
}

SECRET_KEY = os.getenv("SECRET_KEY", "")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable must be set")
ALGORITHM = os.getenv("ALGORITHM", "HS256")

oauth2_bearer = OAuth2PasswordBearer(tokenUrl="/v1/auth/login")

router = APIRouter(
    prefix="/auth",
    tags=["auth"],
)


def get_current_user(token: Annotated[str, Depends(oauth2_bearer)]):

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("id")

        if user_id is None:
            raise HTTPException(status_code=401, detail="Unauthorized")

        if admin["id"] != user_id:
            raise HTTPException(status_code=401, detail="Unauthorized")

        return admin
    except JWTError:
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_admin(user: Annotated[dict[str, str], Depends(get_current_user)]):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admins only")
    return user


def create_access_token(
    username: str, user_id: str, role: str, expires_delta: timedelta
):
    encode = {
        "sub": username,
        "id": user_id,
        "role": role,
        "exp": datetime.now(UTC) + expires_delta,
    }
    return jwt.encode(encode, SECRET_KEY, algorithm=ALGORITHM)


@router.post(
    "/login",
    status_code=status.HTTP_200_OK,
)
async def login(form_data: Annotated[OAuth2PasswordRequestForm, Depends()]):
    if (
        admin["username"] != form_data.username
        or admin["password"] != form_data.password
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="username and/or password are invalid",
        )

    token = create_access_token(
        admin["username"], admin["id"], admin["role"], timedelta(minutes=20)
    )

    return {
        "token": token,
        "user": {"id": admin["id"], "name": admin["name"]},
    }


@router.post("/logout", status_code=status.HTTP_200_OK)
async def logout():
    return {"message": "Logged out"}


@router.get("/me", status_code=status.HTTP_200_OK)
async def read_current_user(
    current_user: Annotated[dict[str, str], Depends(get_current_user)],
):
    return {"user": {"id": current_user["id"], "name": current_user["name"]}}
