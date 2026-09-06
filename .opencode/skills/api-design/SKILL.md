---
name: api-design
description: API conventions, REST patterns, route naming, and FastAPI best practices for this project
metadata:
  stack: python, fastapi, sqlalchemy
---

## API Design Conventions

### Route Structure

- All routes mounted under `/v1` (see `backend/src/app/main.py`)
- Resource-based naming: `/v1/documents/`, `/v1/users/`
- Use plural nouns for collections
- Use path params for specific resources: `/v1/documents/{document_id}`

### Current Routes

```
POST   /v1/documents/          — Upload document
GET    /v1/documents/          — List documents
GET    /v1/documents/{id}      — Get document
DELETE /v1/documents/{id}      — Delete document
POST   /v1/search/             — Semantic search
POST   /v1/qa/                 — Ask question
GET    /v1/health/             — Health check
POST   /v1/auth/register       — Register user
POST   /v1/auth/login          — Login
```

### Request/Response Patterns

- Use Pydantic schemas from `backend/src/app/schemas/` for validation
- Return proper HTTP status codes (201 for create, 204 for delete)
- Use consistent error response format
- Paginate list endpoints

### FastAPI Patterns

- Use dependency injection for database sessions
- Use `Depends()` for auth and validation
- Keep routes thin — business logic goes in services
- Use async/await for I/O operations
- Services are in `backend/src/app/services/`
- Repositories are in `backend/src/app/repositories/`

### Database Models

- SQLAlchemy ORM models in `backend/src/app/models/`
- UUID primary keys for all tables
- Use Alembic for migrations in `backend/migrations/`
- Soft delete where appropriate

### Authentication

- JWT-based auth (currently stubbed with `get_current_user_id()`)
- Auth routes in `backend/src/app/routes/auth.py`
- Auth service in `backend/src/app/services/user.py`
