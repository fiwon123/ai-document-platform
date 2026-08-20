from uuid import UUID

from ..repositories.file import FileRepository
from ..schemas.file import FileResponse


class FileService:
    def __init__(self, repo: FileRepository):
        self.repo = repo

    def get_all(self, id):
        files = self.repo.get_all()

        result = []
        for item in files:
            result.append(FileResponse.model_validate(item))

        return result

    def get_by_id(self, id: UUID):
        file = self.repo.get_by_id(id)

        return file

    def create(self, filename: str, file_path: str):
        pass

    async def update(self, id: UUID, data: dict):
        return self.repo.update(id, data)

    def delete(self, id: UUID):
        return self.repo.delete(
            id,
        )
