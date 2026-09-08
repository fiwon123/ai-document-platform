from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.search import SearchRepository
from app.routes.auth import get_current_user_id
from app.schemas.document import QARequest, QAResponse
from app.services.qa import AVAILABLE_MODELS, QAService
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
    if request.model is not None and request.model not in AVAILABLE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown model: {request.model}",
        )
    return service.ask(
        user_id=owner_id,
        question=request.question,
        document_ids=request.document_ids,
        model=request.model,
    )


@router.get("/models")
def list_models() -> dict:
    """List models available for question answering, split by tier."""
    return QAService.list_models()
