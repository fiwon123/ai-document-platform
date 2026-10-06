import json
import os
from typing import Any

import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD: str | None = os.getenv("REDIS_PASSWORD")
# Bounded connection pool so a traffic spike cannot exhaust file
# descriptors or the Redis server's connection limit.
REDIS_MAX_CONNECTIONS = int(os.getenv("REDIS_MAX_CONNECTIONS", "20"))


class RedisClient:
    def __init__(self):
        self.client = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=REDIS_DB,
            password=REDIS_PASSWORD,
            decode_responses=True,
            max_connections=REDIS_MAX_CONNECTIONS,
        )

    def get(self, key: str) -> str | None:
        return self.client.get(key)

    def set(self, key: str, value: str, ex: int | None = None) -> bool:
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

    def get_json(self, key: str) -> Any | None:
        """Fetch a key and deserialize it from JSON (None when missing)."""
        raw = self.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def set_json(
        self,
        key: str,
        value: Any,
        ex: int | None = None,
    ) -> bool:
        """Serialize a value to JSON and store it under key."""
        return self.set(key, json.dumps(value, default=str), ex=ex)

    def increment(self, key: str) -> int:
        """Atomically increment a counter; used for cache versioning."""
        return self.client.incr(key)

    def increment_by(self, key: str, amount: int) -> int:
        """Atomically add ``amount`` to a counter and return the new value.

        One round trip and one server-side operation, so two concurrent callers
        cannot both read a value and write back a lossy sum. Used by the
        provider token budget, where losing a concurrent increment would
        under-count the day's usage and quietly lift the ceiling.
        """
        if amount == 0:
            return int(self.client.get(key) or 0)
        return int(self.client.incrby(key, amount))

    def decrement(self, key: str, amount: int = 1) -> int:
        """Atomically subtract ``amount``, returning the new value.

        Lets a refused caller hand back a slot it reserved, so being turned
        away does not consume quota that a later request could have used.
        """
        return int(self.client.decrby(key, amount))

    def expire(self, key: str, seconds: int) -> bool:
        """Set a TTL on an existing key."""
        return self.client.expire(key, seconds) > 0


redis_client = RedisClient()
