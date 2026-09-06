from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.search import SearchRepository
from app.routes.auth import get_current_user_id
from app.schemas.document import QARequest, QAResponse
from app.services.qa import QAService
from app.services.search import SearchService

router = APIRouter(prefix="/qa", tags=["qa"])


def get_qa_service(
    db: Annotated[Session, Depends(get_db)],
) -> QAService:
    search_repository = SearchRepository(db)
    search_service = SearchService(repository=search_repository)
    return QAService(search_service=search_service)


@router.post("/ask", response_model=QAResponse)
def ask_question(
    request: QARequest,
    service: Annotated[QAService, Depends(get_qa_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    return service.ask(
        user_id=owner_id,
        question=request.question,
        document_ids=request.document_ids,
    )
