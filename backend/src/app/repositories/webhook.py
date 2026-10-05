from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.webhook import WebhookSubscription


class WebhookRepository:
    """Database access for webhook subscriptions."""

    def __init__(self, db: Session):
        self.db = db

    def list_for_user(self, user_id: UUID) -> list[WebhookSubscription]:
        return (
            self.db.query(WebhookSubscription)
            .filter(WebhookSubscription.user_id == user_id)
            .order_by(WebhookSubscription.created_at.desc())
            .all()
        )

    def get_for_user(
        self,
        subscription_id: UUID,
        user_id: UUID,
    ) -> WebhookSubscription | None:
        return (
            self.db.query(WebhookSubscription)
            .filter(
                WebhookSubscription.id == subscription_id,
                WebhookSubscription.user_id == user_id,
            )
            .first()
        )

    def create(
        self,
        user_id: UUID,
        url: str,
        events: list[str],
        secret: str,
    ) -> WebhookSubscription:
        subscription = WebhookSubscription(
            user_id=user_id,
            url=url,
            events=events,
            secret=secret,
        )
        self.db.add(subscription)
        self.db.commit()
        self.db.refresh(subscription)
        return subscription

    def update(
        self,
        subscription: WebhookSubscription,
        url: str | None = None,
        events: list[str] | None = None,
        is_active: bool | None = None,
    ) -> WebhookSubscription:
        if url is not None:
            subscription.url = url
        if events is not None:
            subscription.events = events
        if is_active is not None:
            subscription.is_active = is_active
        self.db.commit()
        self.db.refresh(subscription)
        return subscription

    def delete(self, subscription: WebhookSubscription) -> None:
        self.db.delete(subscription)
        self.db.commit()

    def record_delivery(
        self,
        subscription: WebhookSubscription,
        *,
        success: bool,
        status_code: int | None,
    ) -> None:
        """Persist the outcome of a delivery attempt on the subscription."""
        subscription.last_status = "success" if success else "failed"
        subscription.last_status_code = status_code
        subscription.last_delivered_at = datetime.now(UTC)
        if success:
            subscription.failure_count = 0
        else:
            subscription.failure_count = (subscription.failure_count or 0) + 1
        self.db.commit()