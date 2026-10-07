import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database.db import Base


class WebhookSubscription(Base):
    """A user-configured endpoint that receives document event notifications.

    Document lifecycle events (processing / ready / failed / deleted) are
    POSTed to the subscriber's URL with an HMAC-SHA256 signature derived
    from the per-subscription ``secret``, so receivers can verify that the
    payload really came from this platform. Delivery state is tracked on
    the row so users can see at a glance whether their endpoint is healthy.
    """

    __tablename__ = "webhook_subscriptions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Receiver URL. Validated at the API layer (http/https, parseable).
    url: Mapped[str] = mapped_column(String(2000), nullable=False)

    # Subscribed event names, e.g. ["document.ready", "document.failed"].
    # Values are validated against the WebhookEvent enum in the schemas.
    events: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)

    # HMAC-SHA256 signing secret for the X-Webhook-Signature header.
    secret: Mapped[str] = mapped_column(String(64), nullable=False)

    is_active: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        nullable=False,
    )

    # Summary of the most recent delivery attempt (None until the first).
    last_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    last_status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    failure_count: Mapped[int] = mapped_column(
        Integer,
        default=0,
        nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )
