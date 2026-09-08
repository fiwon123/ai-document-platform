## Standard Iteration Workflow

Every code change follows this workflow. No exceptions.

Every change is tracked end-to-end on GitHub: **issue → branch → PR → merge**, with
the issue and PR assigned, labeled, linked, and commented at each milestone.

### GitHub conventions (apply to every step)

- **Assignee**: always `fiwon123` (issues AND pull requests)
- **Labels**: match the commit type (see table below)
- **Comments**: post at every milestone (see "Comment milestones" below)
- **Linking**: every PR references its issue (`Closes #N`), and branch names are derived from the work

### Label mapping (commit type → GitHub label)

| Commit type | GitHub label |
|-------------|--------------|
| `feat`      | `enhancement` |
| `fix`       | `bug` |
| `chore`     | `chore` |
| `refactor`  | `refactor` |
| `docs`      | `documentation` |
| `test`      | `test` |
| `ci`        | `ci` |

> If the label does not exist on the repo, create it first:
> `gh label create chore --color C5DEF5 --description "Chores, tooling, and maintenance"`

### Comment milestones

Post these comments automatically — no user prompting required:

| # | Milestone | Target | Template |
|---|-----------|--------|----------|
| 1 | Issue created | issue | `🔍 Starting work on this` |
| 2 | PR opened | issue | `🔗 PR opened: #<pr-number>` |
| 3 | PR opened | PR | Summary of changes + `Closes #<issue-number>` |
| 4 | CI passed | issue | `✅ CI passed — ready to merge` |
| 5 | Merged | issue | `🎉 Merged in <commit-sha>` |
| 6 | Merged | PR | `Merged — thanks!` |

### 1. Plan

- Understand the requirement; ask clarifying questions if ambiguous
- Explore the codebase (read relevant files, follow existing patterns)
- **Create the GitHub issue** (before any branch or code):
  ```bash
  gh issue create \
    --title "<type>: <short description>" \
    --body "<problem statement / acceptance criteria>" \
    --label "<label per mapping table>" \
    --assignee fiwon123
  ```
- **Comment on the issue**: `gh issue comment <issue-number> --body "🔍 Starting work on this"`
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
- The branch implements exactly the issue created in step 1

### One feature per pull request

- Each branch/PR MUST implement exactly ONE feature, fix, or refactor.
- Do NOT bundle multiple unrelated changes into a single branch/PR.
- If additional issues are discovered while implementing, create a separate issue, branch and PR for each one instead of folding them into the current change.
- Tests for the feature being implemented belong in the same PR as the feature.

### 3. Implement

- Make changes in small, focused commits
- Each commit:
  ```bash
  git add <files>
  git commit -m "<type>: <description>"
  ```
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`
- Include a body for non-trivial changes (what and why)
- Do NOT create issues/PRs from subagents — that responsibility stays with the primary agent

### 4. Test

- Backend: `cd backend && uv run pytest` (when tests exist)
- Backend lint: `cd backend && uv run ruff check src/`
- Frontend lint: `cd frontend && npm run lint`
- Frontend build: `cd frontend && npm run build`
- Verify no regressions before opening a PR

### 5. Push & PR

```bash
git push origin <branch>
gh pr create \
  --title "<type>: <description>" \
  --body "<template>" \
  --label "<label per mapping table>" \
  --assignee fiwon123
```

- Fill out the PR template completely (`.github/pull_request_template.md`)
- Link the issue created in step 1: `Closes #<issue-number>`
- **Comment on the issue**: `gh issue comment <issue-number> --body "🔗 PR opened: #<pr-number>"`
- Work only in feature branches — never push directly to main

### 6. Review & Merge

- Verify CI checks pass (green ✅) — backend check, frontend lint, frontend build
- **Comment on the issue**: `gh issue comment <issue-number> --body "✅ CI passed — ready to merge"`
- Self-review the diff for bugs, security, and regressions
- Only merge when explicitly instructed
- Prefer squash merge, then delete the branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
- After merging (the issue auto-closes via `Closes #N`):
  - **Comment on the issue**: `gh issue comment <issue-number> --body "🎉 Merged in <commit-sha>"`
  - **Comment on the PR**: `gh pr comment <number> --body "Merged — thanks!"`
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
- `gh` CLI is authenticated and its credentials persist across devcontainer rebuilds
- Never access secret files (`.env`, etc.) without explicit permission