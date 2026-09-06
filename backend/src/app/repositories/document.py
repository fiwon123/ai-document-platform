from uuid import UUID

from sqlalchemy.orm import Session

from app.models.document import DocumentDB, DocumentStatus


class DocumentRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_by_id(
        self,
        document_id: UUID,
        owner_id: UUID | None = None,
    ):
        query = self.db.query(DocumentDB).filter(DocumentDB.id == document_id)
        if owner_id is not None:
            query = query.filter(DocumentDB.owner_id == owner_id)
        return query.first()

    def get_by_owner(self, owner_id: UUID, skip: int = 0, limit: int = 20):
        return (
            self.db.query(DocumentDB)
            .filter(DocumentDB.owner_id == owner_id)
            .order_by(DocumentDB.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def create(self, document: DocumentDB):
        self.db.add(document)
        self.db.commit()
        self.db.refresh(document)
        return document

    def delete(self, document: DocumentDB):
        self.db.delete(document)
        self.db.commit()

    def update_status(
        self,
        document_id: UUID,
        status: DocumentStatus,
        error_message: str | None = None,
    ):
        document = self.get_by_id(document_id)
        if document is None:
            return None

        document.status = status
        document.error_message = error_message
        self.db.commit()
        self.db.refresh(document)
        return document
