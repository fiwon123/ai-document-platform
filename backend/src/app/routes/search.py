from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.search import SearchRepository
from app.routes.auth import get_current_user_id
from app.schemas.document import SearchRequest, SearchResponse
from app.services.search import SearchService

router = APIRouter(prefix="/search", tags=["search"])


def get_search_service(
    db: Annotated[Session, Depends(get_db)],
) -> SearchService:
    repository = SearchRepository(db)
    return SearchService(repository=repository)


@router.post("/", response_model=SearchResponse)
def search_documents(
    request: SearchRequest,
    service: Annotated[SearchService, Depends(get_search_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    return service.search(
        user_id=owner_id,
        query=request.query,
        top_k=request.top_k,
        offset=request.offset,
    )
