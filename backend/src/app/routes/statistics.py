from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.statistics import StatisticsRepository
from app.routes.auth import get_current_user_id
from app.routes.users import get_current_admin
from app.schemas.statistics import AdminStatisticsResponse, StatisticsResponse
from app.schemas.user import UserResponse
from app.services.statistics import StatisticsService

router = APIRouter(prefix="/statistics", tags=["statistics"])


def get_statistics_service(
    db: Annotated[Session, Depends(get_db)],
) -> StatisticsService:
    repository = StatisticsRepository(db)
    return StatisticsService(repository=repository)


@router.get("/me", response_model=StatisticsResponse)
def get_my_statistics(
    service: Annotated[StatisticsService, Depends(get_statistics_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Dashboard summary for the authenticated user's workspace."""
    return service.get_summary(owner_id)


@router.get("/admin", response_model=AdminStatisticsResponse)
def get_admin_statistics(
    service: Annotated[StatisticsService, Depends(get_statistics_service)],
    _admin: Annotated[UserResponse, Depends(get_current_admin)],
):
    """System-wide aggregates for admins (all users, all documents)."""
    return service.get_admin_summary()