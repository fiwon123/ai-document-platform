from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.routes.auth import get_current_user_id
from app.schemas.webhook import (
    WebhookSubscriptionCreate,
    WebhookSubscriptionResponse,
    WebhookSubscriptionUpdate,
    WebhookTestResponse,
)
from app.services.webhook import WebhookService

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def get_webhook_service(
    db: Annotated[Session, Depends(get_db)],
) -> WebhookService:
    return WebhookService.from_session(db)


@router.get("/", response_model=list[WebhookSubscriptionResponse])
def list_webhooks(
    service: Annotated[WebhookService, Depends(get_webhook_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """List the current user's webhook subscriptions (newest first).

    Signing secrets are returned in masked form; the full value is only
    visible in the create response.
    """
    return service.list_for_user(owner_id)


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    response_model=WebhookSubscriptionResponse,
)
def create_webhook(
    request: WebhookSubscriptionCreate,
    service: Annotated[WebhookService, Depends(get_webhook_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Subscribe the current user to document events at a receiver URL.

    A fresh HMAC signing secret is generated and returned in THIS
    response only — it is masked in every later listing — so capture it
    here to configure the receiver's ``X-Webhook-Signature`` verification.
    """
    return service.create(owner_id, request)


@router.put(
    "/{subscription_id}",
    response_model=WebhookSubscriptionResponse,
)
def update_webhook(
    subscription_id: UUID,
    request: WebhookSubscriptionUpdate,
    service: Annotated[WebhookService, Depends(get_webhook_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Update the URL, subscribed events, or active flag of a subscription.

    The signing secret is never returned in full here — it is masked in
    the response just like listings.
    """
    return service.update(subscription_id, owner_id, request)


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_webhook(
    subscription_id: UUID,
    service: Annotated[WebhookService, Depends(get_webhook_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Delete a webhook subscription."""
    service.delete(subscription_id, owner_id)


@router.post("/{subscription_id}/test", response_model=WebhookTestResponse)
async def test_webhook(
    subscription_id: UUID,
    service: Annotated[WebhookService, Depends(get_webhook_service)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Deliver a one-off ``ping`` payload to verify the receiver endpoint.

    The result is also recorded in the subscription's delivery stats, so a
    manual test doubles as a health probe. The receiver can verify
    authenticity via the ``X-Webhook-Signature`` header (HMAC-SHA256).
    """
    return await service.send_test(subscription_id, owner_id)
