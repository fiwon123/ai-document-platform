from uuid import UUID

from sqlalchemy.orm import Session

from ..models.file import FileDB


class FileRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_by_id(self, id: UUID):
        file = self.db.query(FileDB).filter(FileDB.id == id).first()

        return file

    def get_all(self):
        files = self.db.query(FileDB).all()

        if files is None:
            return []

        return files

    def create(self, user_id: UUID, filename: str, file_path: str):
        file = FileDB(user_id, filename, file_path)
        self.db.add(file)
        self.db.commit()
        self.db.refresh(file)

        return file

    def update(self, id: UUID, data: dict):
        file = self.get_by_id(data)

        if file is None:
            return None

        for key, value in data.items():
            setattr(file, key, value)

        self.db.commit()
        self.db.refresh(file)

        return file

    def delete(self, id: UUID):
        file = self.get_by_id(id)

        if file is None:
            return None

        self.db.delete(file)
        self.db.commit()

        return file
