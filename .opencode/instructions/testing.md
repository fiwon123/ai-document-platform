## Testing Requirements

### General

- Tests are mandatory for new features and bug fixes
- Write tests before or alongside implementation
- Mock external services (OpenAI, MinIO) — never call real APIs in tests
- Aim for critical path coverage, not 100% line coverage

### Backend (Python)

- **Framework**: pytest
- **Location**: `backend/tests/`
- **Run**: `cd backend && uv run pytest`
- **Run with verbose**: `cd backend && uv run pytest -v`
- **Run specific test**: `cd backend && uv run pytest tests/test_document.py`

#### Test Structure

```
backend/tests/
├── conftest.py          # Shared fixtures
├── test_document.py     # Document endpoint tests
├── test_search.py       # Search endpoint tests
├── test_qa.py           # QA endpoint tests
└── test_user.py         # User/auth tests
```

#### Conventions

- Test files: `test_<module>.py`
- Test functions: `test_<description>`
- Use fixtures from `conftest.py`
- Mock external services with `unittest.mock` or `pytest-mock`

### Frontend (TypeScript)

- **Framework**: Vitest (recommended)
- **Location**: `frontend/src/**/*.test.ts(x)`
- **Run**: `cd frontend && npm test`
- **Run with coverage**: `cd frontend && npm test -- --coverage`

#### Test Structure

```
frontend/src/
├── components/
│   └── Navbar.test.tsx
├── pages/
│   └── DocumentsPage.test.tsx
├── services/
│   └── api.test.ts
└── hooks/
    └── useAuth.test.tsx
```

#### Conventions

- Test files: `<module>.test.ts(x)`
- Test functions: `it('should <description>')`
- Mock API calls with `vi.mock()`
- Use `@testing-library/react` for component tests

### Linting

```bash
# Backend (Python)
cd backend && uv run ruff check src/

# Frontend (TypeScript)
cd frontend && npm run lint
cd frontend && npm run lint:fix
```

### Before Committing

1. Run backend tests: `cd backend && uv run pytest`
2. Run frontend lint: `cd frontend && npm run lint`
3. Run frontend build: `cd frontend && npm run build`
4. Verify no regressions
