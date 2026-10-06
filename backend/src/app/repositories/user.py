from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.document import DocumentDB
from ..models.user import UserDB


class UserRepository:
    def __init__(self, db: Session):
        self.db = db

    def list_object_keys(self, id: UUID) -> list[str]:
        """Storage keys of every document the user owns.

        Read *before* the account is deleted, because the cascade removes the
        document rows and the objects in MinIO/S3 are outside the database
        entirely: nothing but this list can say which ones have to go (#495).
        Without it, deleting an account leaves the uploaded files behind,
        reachable by anyone who still holds or reconstructs the key.

        Only the primary object key is returned; the caller derives each
        thumbnail key from it the same way document deletion does.
        """
        rows = self.db.execute(select(DocumentDB.object_key).where(DocumentDB.owner_id == id))
        return [row[0] for row in rows]

    def get_by_id(self, id: UUID):
        user = self.db.query(UserDB).filter(UserDB.id == id).first()
        return user

    def get_by_username(self, username: str):
        user = self.db.query(UserDB).filter(UserDB.username == username).first()
        return user

    def get_all(self):
        users = self.db.query(UserDB).all()
        if users is None:
            return []
        return users

    def create(self, username: str, hashed_password: str):
        user = UserDB(username=username, hashed_password=hashed_password)
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def update(self, id: UUID, data: dict):
        user = self.get_by_id(id)
        if user is None:
            return None
        for key, value in data.items():
            if hasattr(user, key):
                setattr(user, key, value)
        self.db.commit()
        self.db.refresh(user)
        return user

    def delete(self, id: UUID):
        user = self.get_by_id(id)
        if user is None:
            return None
        self.db.delete(user)
        self.db.commit()
        return user
