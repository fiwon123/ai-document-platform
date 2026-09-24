from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field

# Event names a subscription can opt into. Values are dotted identifiers
# (``document.<status>``) delivered to receivers in the ``X-Webhook-Event``
# header and the payload's ``event`` field.
#
# ``ping`` is not a subscribable event; it is only used by the manual
# ``POST /v1/webhooks/{id}/test`` endpoint to verify a receiver endpoint.


class WebhookEvent(StrEnum):
    PROCESSING = "document.processing"
    READY = "document.ready"
    FAILED = "document.failed"
    DELETED = "document.deleted"


class WebhookSubscriptionCreate(BaseModel):
    url: str = Field(
        min_length=1,
        max_length=2000,
        description=(
            "HTTP(S) endpoint that receives notifications. Scheme must be "
            "http or https."
        ),
    )
    events: list[WebhookEvent] = Field(
        min_length=1,
        description="Document events to subscribe to (at least one).",
    )


class WebhookSubscriptionUpdate(BaseModel):
    url: str | None = Field(
        default=None,
        min_length=1,
        max_length=2000,
        description="HTTP(S) endpoint that receives notifications.",
    )
    events: list[WebhookEvent] | None = Field(
        default=None,
        min_length=1,
        description="Document events to subscribe to.",
    )
    is_active: bool | None = Field(
        default=None,
        description="Pause/resume delivery without deleting the subscription.",
    )


class WebhookSubscriptionResponse(BaseModel):
    id: UUID
    url: str
    events: list[str]
    is_active: bool
    # HMAC-SHA256 signing secret for verifying the X-Webhook-Signature
    # header. The full value is only returned by the create endpoint
    # (capture-once); listings and updates return a masked form.
    secret: str
    last_status: str | None = None
    last_status_code: int | None = None
    last_delivered_at: datetime | None = None
    failure_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WebhookTestResponse(BaseModel):
    """Result of a manual test delivery (``POST /v1/webhooks/{id}/test``)."""

    delivered: bool
    event: str
    status_code: int | None
    message: str