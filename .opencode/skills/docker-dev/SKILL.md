---
name: docker-dev
description: Docker Compose development, container hot-reload, and service management rules
metadata:
  services: postgres, redis, minio, backend, frontend
---

## Docker Development Rules

### Services Overview

| Service | Port | Purpose |
|---------|------|---------|
| backend | 8000 | FastAPI + uvicorn |
| frontend | 5173 | Vite dev server |
| postgres | 5433 (host) → 5432 (container) | PostgreSQL 16 + pgvector |
| redis | 6379 | Caching |
| minio | 9000/9001 | S3-compatible storage |

### Starting Services

```bash
# All services
docker compose up -d

# Dev services only (backend + frontend)
docker compose up -d backend frontend

# Infrastructure only
docker compose up -d postgres redis minio
```

### Hot Reload

- **Backend**: uvicorn `--reload` is enabled — changes auto-restart
- **Frontend**: Vite dev server auto-reloads on file changes
- Volume mounts sync changes from host to container

### Common Commands

```bash
# View logs
docker compose logs -f backend
docker compose logs -f postgres

# Shell into container
docker compose exec backend bash
docker compose exec postgres psql -U postgres -d mydb

# Stop and remove volumes (clean slate)
docker compose down -v

# Rebuild after dependency changes
docker compose build --no-cache backend
docker compose up -d backend
```

### Database Operations

```bash
# Run migrations
docker compose exec backend uv run python -m alembic upgrade head

# Create new migration
docker compose exec backend uv run python -m alembic revision --autogenerate -m "description"

# Check migration status
docker compose exec backend uv run python -m alembic current
```

### MinIO Console

- URL: http://localhost:9001
- User: minioadmin
- Password: minioadmin

### Troubleshooting

- If backend fails to start, check `docker compose logs backend`
- Common issue: PostgreSQL not ready — wait for healthy status
- If port conflicts, check `docker ps` for running containers
- Volume issues: `docker compose down -v` then `docker compose up -d`
