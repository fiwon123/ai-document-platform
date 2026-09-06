import os
from typing import Optional
import redis


REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD: Optional[str] = os.getenv("REDIS_PASSWORD")


class RedisClient:
    def __init__(self):
        self.client = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=REDIS_DB,
            password=REDIS_PASSWORD,
            decode_responses=True,
        )

    def get(self, key: str) -> Optional[str]:
        return self.client.get(key)

    def set(
        self, key: str, value: str, ex: Optional[int] = None
    ) -> bool:
        return self.client.set(key, value, ex=ex)

    def delete(self, key: str) -> bool:
        return self.client.delete(key) > 0

    def exists(self, key: str) -> bool:
        return self.client.exists(key) > 0

    def ping(self) -> bool:
        try:
            return self.client.ping()
        except redis.ConnectionError:
            return False


redis_client = RedisClient()
