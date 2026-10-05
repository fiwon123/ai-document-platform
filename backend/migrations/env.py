import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.database import Base
from app.models import (  # noqa: F401 — registers all ORM models on Base.metadata for autogenerate
    DocumentChunk,
    DocumentDB,
    DocumentStatus,
    Role,
    SearchHistory,
    UserDB,
    WebhookSubscription,
)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

db_url = os.getenv("DATABASE_URL")
if db_url:
    config.set_main_option("sqlalchemy.url", db_url)
else:
    # No DATABASE_URL: build it from the POSTGRES_* variables (the same
    # configuration the application uses). Credentials are never
    # hardcoded here, so a missing value fails loudly instead of
    # silently using a placeholder.
    db_user = os.getenv("POSTGRES_USER", "postgres")
    db_password = os.getenv("POSTGRES_PASSWORD")
    db_host = os.getenv("POSTGRES_HOST", "localhost")
    db_port = os.getenv("POSTGRES_PORT", "5432")
    db_name = os.getenv("POSTGRES_DB", "mydb")

    if not db_password:
        raise RuntimeError(
            "DATABASE_URL is not set and POSTGRES_PASSWORD is missing — "
            "set DATABASE_URL or configure the POSTGRES_* variables"
        )

    config.set_main_option(
        "sqlalchemy.url",
        f"postgresql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}",
    )


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
