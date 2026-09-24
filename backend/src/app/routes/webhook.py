from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database.db import get_db
from app.repositories.webhook import WebhookRepository
from app.routes.auth import get_current_user_id
from app.schemas.webhook import (
    WebhookEvent,
    WebhookSubscriptionCreate,
    WebhookSubscriptionResponse,
    WebhookSubscriptionUpdate,
    WebhookTestResponse,
)
from app.services.webhook import (
    deliver_test_payload,
    generate_secret,
    is_valid_webhook_url,
    mask_secret,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def get_webhook_repository(
    db: Annotated[Session, Depends(get_db)],
) -> WebhookRepository:
    return WebhookRepository(db)


def _events_as_strings(events: list[WebhookEvent]) -> list[str]:
    return [event.value for event in events]


def _masked_response(subscription) -> WebhookSubscriptionResponse:
    """Serialize a subscription with a masked signing secret.

    The full secret is capture-once: only the create response carries it,
    so anyone already holding the key can rotate by deleting/recreating.
    """
    response = WebhookSubscriptionResponse.model_validate(subscription)
    response.secret = mask_secret(subscription.secret)
    return response


@router.get("/", response_model=list[WebhookSubscriptionResponse])
def list_webhooks(
    repository: Annotated[WebhookRepository, Depends(get_webhook_repository)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """List the current user's webhook subscriptions (newest first).

    Signing secrets are returned in masked form; the full value is only
    visible in the create response.
    """
    return [
        _masked_response(subscription)
        for subscription in repository.list_for_user(owner_id)
    ]


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    response_model=WebhookSubscriptionResponse,
)
def create_webhook(
    request: WebhookSubscriptionCreate,
    repository: Annotated[WebhookRepository, Depends(get_webhook_repository)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Subscribe the current user to document events at a receiver URL.

    A fresh HMAC signing secret is generated and returned in THIS
    response only — it is masked in every later listing — so capture it
    here to configure the receiver's ``X-Webhook-Signature`` verification.
    """
    if not is_valid_webhook_url(request.url):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="URL must be a valid http:// or https:// endpoint",
        )
    return repository.create(
        user_id=owner_id,
        url=request.url,
        events=_events_as_strings(request.events),
        secret=generate_secret(),
    )


@router.put(
    "/{subscription_id}",
    response_model=WebhookSubscriptionResponse,
)
def update_webhook(
    subscription_id: UUID,
    request: WebhookSubscriptionUpdate,
    repository: Annotated[WebhookRepository, Depends(get_webhook_repository)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Update the URL, subscribed events, or active flag of a subscription.

    The signing secret is never returned in full here — it is masked in
    the response just like listings.
    """
    subscription = repository.get_for_user(subscription_id, owner_id)
    if subscription is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook subscription not found",
        )
    if request.url is not None and not is_valid_webhook_url(request.url):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="URL must be a valid http:// or https:// endpoint",
        )
    updated = repository.update(
        subscription,
        url=request.url,
        events=(
            _events_as_strings(request.events)
            if request.events is not None
            else None
        ),
        is_active=request.is_active,
    )
    return _masked_response(updated)


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_webhook(
    subscription_id: UUID,
    repository: Annotated[WebhookRepository, Depends(get_webhook_repository)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Delete a webhook subscription."""
    subscription = repository.get_for_user(subscription_id, owner_id)
    if subscription is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook subscription not found",
        )
    repository.delete(subscription)


@router.post("/{subscription_id}/test", response_model=WebhookTestResponse)
async def test_webhook(
    subscription_id: UUID,
    repository: Annotated[WebhookRepository, Depends(get_webhook_repository)],
    owner_id: Annotated[UUID, Depends(get_current_user_id)],
):
    """Deliver a one-off ``ping`` payload to verify the receiver endpoint.

    The result is also recorded in the subscription's delivery stats, so a
    manual test doubles as a health probe. The receiver can verify
    authenticity via the ``X-Webhook-Signature`` header (HMAC-SHA256).
    """
    subscription = repository.get_for_user(subscription_id, owner_id)
    if subscription is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook subscription not found",
        )
    delivered, status_code, message = await deliver_test_payload(subscription)
    repository.record_delivery(
        subscription,
        success=delivered,
        status_code=status_code,
    )
    return WebhookTestResponse(
        delivered=delivered,
        event="ping",
        status_code=status_code,
        message=message,
    )