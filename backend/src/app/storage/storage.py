import os

import boto3
from botocore.config import Config as BotocoreConfig
from dotenv import load_dotenv

load_dotenv()


MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "localhost:9000")
MINIO_PUBLIC_ENDPOINT = os.getenv("MINIO_PUBLIC_ENDPOINT", "localhost:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")
MINIO_SECURE = False

scheme = "https" if MINIO_SECURE else "http"

storage_client = boto3.client(
    "s3",
    endpoint_url=f"{scheme}://{MINIO_ENDPOINT}",
    aws_access_key_id=MINIO_ACCESS_KEY,
    aws_secret_access_key=MINIO_SECRET_KEY,
    config=BotocoreConfig(signature_version="s3v4"),
    region_name="us-east-1",
)


public_storage_client = boto3.client(
    "s3",
    endpoint_url=f"{scheme}://{MINIO_PUBLIC_ENDPOINT}",
    aws_access_key_id=MINIO_ACCESS_KEY,
    aws_secret_access_key=MINIO_SECRET_KEY,
    config=BotocoreConfig(signature_version="s3v4"),
    region_name="us-east-1",
)


def ensure_bucket(name: str):
    try:
        storage_client.head_bucket(Bucket=name)
    except Exception:
        storage_client.create_bucket(Bucket=name)
