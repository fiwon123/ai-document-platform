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

## Visual checks

Numbers are not enough to tell you a page is right. A DOM can be valid, a
stylesheet can be correct, a test can be green, and the rendered page can still be
visually broken — clipped text, an overflowing container, a contrast failure, a
dark theme that only works in light.

The agent is a **multimodal** model, so captures are looked at, not just counted.

### Capture

The dev image ships headless Chromium, so this needs no setup:

```bash
# A page, light and dark, desktop and narrow
playwright screenshot --full-page http://localhost:5173/pricing /tmp/opencode/light.png
playwright screenshot --color-scheme=dark --full-page http://localhost:5173/pricing /tmp/opencode/dark.png
playwright screenshot --viewport-size=390,844 --full-page http://localhost:5173/pricing /tmp/opencode/mobile.png
```

`playwright` is installed in the dev image — call it directly, never via `npx`
(DESVELOPMENT.md explains why). `--wait-for-timeout=800` helps on pages that
fetch. The agent runs inside the container, so `localhost:5173` is the app.

The multi-route audit (`node scripts/audit.mjs`, with `--gate`,
`--pixel-baseline=DIR`, `--only=`, `--video-themes=`) is **broken in this
container** — a Playwright/browser revision mismatch (#529) — so it cannot be
relied on until that is fixed.

Animation capture is **WebM, not GIF**: the image's ffmpeg is Playwright's
screencast build and has no GIF muxer. For motion, write a short script using
`page.videoPath()`.

### Look

Write captures under `/tmp/opencode/` **inside the dev container** — which is
where the agent runs, so the path is readable as-is, with no `docker compose cp`.

`read` renders images, GIFs and PDFs. Delegate to the `visual` subagent
(`opencode/mimo-v2.6-flash-free`, marked yellow) and act on its findings.

### Why two layers

The audit's `--gate` is the objective layer: contrast ratios, page errors,
landmarks, overflow, unlabelled controls. It is deterministic and it is a real
CI signal — once #529 unbreaks the audit.

The visual read is the semantic layer: is this page actually *usable and
correct-looking*? It catches what no signal encodes.

Pixel diffing is deliberately **not** a gate (#485). Captures vary by a
sub-pixel band across machines, so a baseline is only comparable against the
machine that produced it — a mismatch is a reason to look, not a red X.

### Rules

- **Both themes, every time.** A change verified only in light mode is unverified.
- **Re-capture after fixing.** A fix is not verified until it has been looked at again.
- Report what you *see*. If you have not looked, say so.
