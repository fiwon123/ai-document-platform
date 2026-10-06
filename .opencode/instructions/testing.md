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

> ⚠️ **The backend suite drops every table in the database it connects to.** It
> targets `mydb_test`; `conftest.py` forces `DATABASE_URL` there and
> `_assert_test_database` refuses to run against anything else. Do not "fix" a
> failing suite by exporting a `DATABASE_URL` pointing at `mydb` — that empties
> the dev database, silently, while the suite still reports green (#683).
> Recovery steps are in `DEVELOPMENT.md` → *Recovering a database the suite emptied*.

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

Looking is a real step, but it is done by the **`visual` subagent**
(`opencode/mimo-v2.6-flash-free`), not by the main agent. The main agent has no
image input at all — `read` on a PNG returns "this model does not support image
input". So the rule is: **the main agent captures, the `visual` subagent looks,
the main agent acts on the findings.** Never report a visual conclusion the
`visual` subagent has not actually returned; if a review fails or is
rate-limited, say the state is unverified and retry in a smaller batch rather
than carrying the claim forward. (#548 shipped a PR body claiming a state had
been visually reviewed when the one review that could have caught it had failed
with `Rate limit exceeded`.)

### Cadence: targeted while you work, full once at the end

Do **not** run the full audit for every change. It is ~13 minutes and 300+
captures, and nearly all of them are routes the change did not touch. Verifying
one button does not require photographing the whole site.

| When | What |
|---|---|
| **While you work** | Targeted: the affected route(s) only, at the viewport that matters, in **both themes**. This is the iteration loop. |
| **Before the PR** | The full `node scripts/audit.mjs --gate`, once, as the regression net. |

The expensive thing runs once per feature, not once per edit. If a targeted
capture shows a problem, fix it and re-capture **the same targeted set** — do not
escalate to the full audit to check one button.

### Which artifact the change needs

Not every change needs every artifact. Choose by what the change *is*:

| The change is… | Take | Why |
|---|---|---|
| Layout, colour, copy, spacing, typography, a static state | **screenshot** | A still shows it completely. |
| Anything temporal — transition, hover reveal, dropdown/menu open, toast, streaming response, scroll behaviour | **screenshot + video** | A still genuinely *cannot* show motion. This is the one case where a screenshot is insufficient rather than merely less convenient. |
| A long page, or a sequence that would otherwise be many frames | **screenshot + GIF** | One file instead of N. `/how-it-works` on mobile is 11 step captures; as a GIF it is one attachment. |
| Motion, reviewed for smoothness or timing | **video** (GIF if a summary will do) | Video is the precise artifact, the GIF the cheap one. |

**Why the GIF is not a nicety.** `read` renders images, GIFs and PDFs — it does
**not** render WebM. An animation recorded as `.webm` is therefore unreviewable,
and motion can only be reviewed as a pile of separate stills. That pile is what
caused the 2026-09-29 review fan-out to come back `Rate limit exceeded`, with
several cancellations: `/how-it-works` on mobile is 11 attachments for one page.
**One GIF is one attachment**, and that is the difference between a review that
completes and one that gets cancelled.

Use the GIF *to review*; keep the PNGs *to read fine text*. A 640px GIF is a
motion summary, not a replacement for a full-resolution capture.

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
`--pixel-baseline=DIR`, `--only=`, `--video-themes=`) drives the same baked
Chromium. Its first log line names the Playwright version, the install it came
from and the chromium revision — check it when a capture looks wrong, because
that is what a browser mismatch looks like from the outside (#529).

Animation capture is **WebM, not GIF**: the image's ffmpeg is Playwright's
screencast build and has no GIF muxer. For motion, write a short script using
`page.videoPath()`.

### Look

Write captures under `/tmp/opencode/` **inside the dev container** — which is
where the agent runs, so the path is readable as-is, with no `docker compose cp`.

`read` renders images, GIFs and PDFs — **not** WebM. Delegate to the `visual`
subagent and act on its findings. A `.webm` handed to it is a file nobody can
look at, which is why motion is packed into a GIF before review.

### Why two layers

The audit's `--gate` is the objective layer: contrast ratios, page errors,
landmarks, overflow, unlabelled controls. It is deterministic and it is a real
CI signal.

The visual read is the semantic layer: is this page actually *usable and
correct-looking*? It catches what no signal encodes.

Pixel diffing is deliberately **not** a gate (#485). Captures vary by a
sub-pixel band across machines, so a baseline is only comparable against the
machine that produced it — a mismatch is a reason to look, not a red X.

### Rules

- **Both themes, every time.** A change verified only in light mode is unverified.
- **Re-capture after fixing.** A fix is not verified until it has been looked at again.
- Report what you *see*. If you have not looked, say so.
