import os
from typing import BinaryIO

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default

    return value.lower() in {"true", "1", "yes", "on"}


def normalize_endpoint(endpoint: str, secure: bool) -> str:
    if endpoint.startswith(("http://", "https://")):
        return endpoint

    scheme = "https" if secure else "http"

    return f"{scheme}://{endpoint}"


MINIO_ENDPOINT = os.getenv(
    "MINIO_ENDPOINT",
    "localhost:9000",
)

MINIO_ACCESS_KEY = os.getenv(
    "MINIO_ACCESS_KEY",
    "minioadmin",
)

MINIO_SECRET_KEY = os.getenv(
    "MINIO_SECRET_KEY",
    "minioadmin",
)

MINIO_BUCKET = os.getenv(
    "MINIO_BUCKET",
    "documents",
)

MINIO_SECURE = parse_bool(
    os.getenv("MINIO_SECURE"),
    default=False,
)

MINIO_REGION = os.getenv(
    "MINIO_REGION",
    "us-east-1",
)

# botocore's own defaults are a 60-second connect timeout and 5 attempts in
# legacy mode, so one call against an unreachable object store costs ~10s.
# That is not a resilience policy, it is an accident of a default — and it is
# paid on the app's startup path (`ensure_bucket` in the lifespan) and again
# before every upload, so a hung store stalls startup and every write that
# touches it (#634).
#
# Bounded explicitly instead. `MAX_ATTEMPTS` is botocore's *retry* count, not
# its attempt count: botocore rewrites it to `total_max_attempts = N + 1`, so 2
# is three calls — the first plus two retries. A ceiling rather than zero,
# because a transient blip on a real upload should not become a user-visible
# failure; and not botocore's 5, because the call this bounds is a
# reachability probe whose failure is already caught and logged, so the extra
# attempts only delay finding out.
CONNECT_TIMEOUT_SECONDS = 2.0
READ_TIMEOUT_SECONDS = 5.0
MAX_ATTEMPTS = 2


class MinioStorage:
    def __init__(
        self,
        endpoint: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        secure: bool = False,
        region: str = "us-east-1",
    ):
        self.bucket = bucket

        self.client = self._create_client(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
            region=region,
        )

    @staticmethod
    def _create_client(
        endpoint: str,
        access_key: str,
        secret_key: str,
        secure: bool,
        region: str,
    ):
        return boto3.client(
            "s3",
            endpoint_url=normalize_endpoint(endpoint, secure),
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(
                signature_version="s3v4",
                connect_timeout=CONNECT_TIMEOUT_SECONDS,
                read_timeout=READ_TIMEOUT_SECONDS,
                retries={"max_attempts": MAX_ATTEMPTS, "mode": "standard"},
            ),
            region_name=region,
        )

    def ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(
                Bucket=self.bucket,
            )

        except ClientError as error:
            error_code = error.response.get(
                "Error",
                {},
            ).get("Code")

            if error_code in {"404", "NoSuchBucket"}:
                self.client.create_bucket(
                    Bucket=self.bucket,
                )
            else:
                raise

    def upload(
        self,
        file_object: BinaryIO,
        object_key: str,
        content_type: str | None = None,
    ) -> str:
        # Defensive: ensure bucket exists before uploading.  This covers
        # the case where the bucket was removed after startup or the
        # startup ensure_bucket() call failed.
        self.ensure_bucket()

        extra_args = {}

        if content_type:
            extra_args["ContentType"] = content_type

        self.client.upload_fileobj(
            Fileobj=file_object,
            Bucket=self.bucket,
            Key=object_key,
            ExtraArgs=extra_args,
        )

        return object_key

    def download(self, object_key: str):
        response = self.client.get_object(
            Bucket=self.bucket,
            Key=object_key,
        )

        return response["Body"]

    def open_object(self, object_key: str):
        """Return ``(body, content_length)`` for reading an object's bytes.

        The body is boto3's streaming object rather than a bytes blob, so serving
        a 40 MB upload through the API does not buffer 40 MB per request. The
        caller is responsible for closing it, which ``StreamingResponse`` does
        when the response is finished.

        Deliberately not a presigned URL: a URL would have to name an endpoint
        the *browser* can reach, and that host is a configuration guess
        (#536). This route knows only its own origin, which the browser
        demonstrably can reach.
        """
        response = self.client.get_object(
            Bucket=self.bucket,
            Key=object_key,
        )

        return response["Body"], int(response.get("ContentLength") or 0)

    def delete(self, object_key: str) -> None:
        self.client.delete_object(
            Bucket=self.bucket,
            Key=object_key,
        )


storage = MinioStorage(
    endpoint=MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    bucket=MINIO_BUCKET,
    secure=MINIO_SECURE,
    region=MINIO_REGION,
)
