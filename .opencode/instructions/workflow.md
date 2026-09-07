## Standard Iteration Workflow

Every code change follows this workflow. No exceptions.

### 1. Plan

- Understand the requirement; ask clarifying questions if ambiguous
- Explore the codebase (read relevant files, follow existing patterns)
- Output: Goal, Files to modify, Dependencies, Risks, Steps
- Get user approval before proceeding to implementation

### 2. Branch

- Always start from an up-to-date main:
  ```bash
  git checkout main
  git pull origin main
  git checkout -b <type>/<short-description>
  ```
- Branch types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`, `ci/`
- Example: `feat/document-chunking`, `fix/auth-token-expiry`

### 3. Implement

- Make changes in small, focused commits
- Each commit:
  ```bash
  git add <files>
  git commit -m "<type>: <description>"
  ```
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`
- Include a body for non-trivial changes (what and why)

### 4. Test

- Backend: `cd backend && uv run pytest` (when tests exist)
- Backend lint: `cd backend && uv run ruff check src/`
- Frontend lint: `cd frontend && npm run lint`
- Frontend build: `cd frontend && npm run build`
- Verify no regressions before opening a PR

### 5. Push & PR

```bash
git push origin <branch>
gh pr create --title "<type>: <description>" --body "<template>"
```

- Fill out the PR template completely (`.github/pull_request_template.md`)
- Link related issues (`Closes #42`)
- Work only in feature branches — never push directly to main

### 6. Review & Merge

- Verify CI checks pass (green ✅) — backend check, frontend lint, frontend build
- Self-review the diff for bugs, security, and regressions
- Only merge when explicitly instructed
- Prefer squash merge, then delete the branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
- If a PR/branch is not necessary, close it with a comment explaining why

### 7. Cleanup

```bash
git checkout main
git pull origin main
git remote prune origin
```

- Verify clean state: only `main` remains locally and on the remote

### Environment Notes

- This project runs inside a Dev Container — there is NO docker CLI available
  (services run in separate containers, reachable via forwarded ports)
- Backend: Python 3.14 managed by `uv` — use `uv run`, never pip directly
- Frontend: Node 22 managed by `npm`
- Never access secret files (`.env`, etc.) without explicit permission