from passlib.context import CryptContext

from ..repositories.user import UserRepository
from ..schemas.user import UserResponse


class UserService:
    def __init__(self, repo: UserRepository):
        self.repo = repo
        self.crypt_context = CryptContext(schemes=["bcrypt"],
                                          deprecated="auto")

    def get_all(self):

        users = self.repo.get_all()

        result = []
        for item in users:
            result.append(UserResponse.model_validate(item))

        return result

    def get_by_id(self, id: int):
        user = self.repo.get_by_id(id)

        return user

    def create(self, username: str, password: str):
        return self.repo.create(username, self.crypt_context.hash(password))

    async def update(self, id: int, data: dict):
        return self.repo.update(id, data)

    def delete(self, id: int):
        return self.repo.delete(
            id,
        )
