import json
import os
from typing import Any

import redis

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
REDIS_DB = int(os.getenv("REDIS_DB", "0"))
REDIS_PASSWORD: str | None = os.getenv("REDIS_PASSWORD")
REDIS_MAX_CONNECTIONS = int(os.getenv("REDIS_MAX_CONNECTIONS", "20"))


class RedisClient:
    def __init__(self):
        # A shared connection pool bounds the number of sockets the app
        # opens against Redis. Under heavy load, queueing on a full pool
        # is preferable to exhausting the server's connection limit.
        self._pool = redis.ConnectionPool(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=REDIS_DB,
            password=REDIS_PASSWORD,
            decode_responses=True,
            max_connections=REDIS_MAX_CONNECTIONS,
        )
        self.client = redis.Redis(connection_pool=self._pool)

    def get(self, key: str) -> str | None:
        return self.client.get(key)

    def set(
        self, key: str, value: str, ex: int | None = None
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

    def increment_with_ttl(self, key: str, ttl: int) -> int:
        """Atomically increment a counter and ensure it expires.

        INCR and EXPIRE are wrapped in a single MULTI/EXEC transaction so
        there is no window where the key exists without an expiry (e.g. a
        crash between the two commands would otherwise leak a permanent
        key). The TTL is applied with ``nx=True`` so it is only ever set
        on the first request.
        """
        pipe = self.client.pipeline(transaction=True)
        pipe.incr(key)
        pipe.expire(key, ttl, nx=True)
        results = pipe.execute()
        return results[0]


redis_client = RedisClient()