## Standard Iteration Workflow

Every code change follows this workflow. No exceptions.

Every change is tracked end-to-end on GitHub: **issue → branch → PR → merge**, with
the issue and PR assigned, labeled, linked, and commented at each milestone.

### GitHub conventions (apply to every step)

- **Assignee**: always `fiwon123` (issues AND pull requests)
- **Labels**: match the commit type (see table below)
- **Milestones**: every issue must be assigned to a milestone (see "Milestone conventions" below)
- **Comments**: post at every milestone (see "Comment milestones" below)
- **Linking**: every PR references its issue (`Closes #N`), and branch names include the issue number

### Linking conventions (mandatory)

Every change must be traceable end-to-end:

| From | To | How |
|------|-----|-----|
| Branch | Issue | Branch name includes issue number: `feat/42-document-chunking` |
| PR | Issue | `Closes #<number>` in PR body |
| PR | Milestone | `gh pr edit <number> --milestone "<name>"` |
| Issue | Milestone | `gh issue edit <number> --milestone "<name>"` |
| Commit | Issue | Conventional commit with issue context |

No orphaned branches, PRs, or issues. Every piece of work is linked.

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
> `gh label create <name> --color <hex> --description "<description>"`

### Milestone conventions

- Every issue MUST be assigned to a milestone before work begins
- Milestones represent releases or sprint iterations
- Use `gh issue edit <number> --milestone "<milestone-name>"`
- When creating issues, assign to the current active milestone
- Track milestone progress on the GitHub Milestones page

### Comment milestones

Post these comments automatically — no user prompting required:

| # | Milestone | Target | Template |
|---|-----------|--------|----------|
| 1 | Issue created | issue | `Starting work on this — Milestone: <milestone>` |
| 2 | PR opened | issue | `PR opened: #<pr-number>` |
| 3 | PR opened | PR | Summary of changes + `Closes #<issue-number>` |
| 4 | Merged to dev | issue | `Merged into dev — ready for release` |
| 5 | Merged to dev | PR | `Merged into dev — thanks!` |
| 6 | dev → main PR opened | issue | `Release PR opened: #<pr-number>` |
| 7 | CI passed | issue | `CI passed — ready to merge to main` |
| 8 | Merged to main | issue | `Released in <commit-sha>` |
| 9 | Merged to main | PR | `Released — thanks!` |

### 1. Plan

- Understand the requirement; ask clarifying questions if ambiguous
- Explore the codebase (read relevant files, follow existing patterns)
- **Create the GitHub issue** (before any branch or code):
  ```bash
  gh issue create \
    --title "<type>: <short description>" \
    --body "<problem statement / acceptance criteria>" \
    --label "<label per mapping table>" \
    --assignee fiwon123 \
    --milestone "<milestone-name>"
  ```
- **Comment on the issue**: `gh issue comment <issue-number> --body "Starting work on this — Milestone: <milestone>"`
- Output: Goal, Files to modify, Dependencies, Risks, Steps
- Get user approval before proceeding to implementation

### 2. Branch

- Always start from an up-to-date `dev`:
  ```bash
  git checkout dev
  git pull origin dev
  git checkout -b <type>/<issue-number>-<slug>
  ```
- Branch types: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`, `ci/`
- Examples: `feat/42-document-chunking`, `fix/17-auth-token-expiry`, `refactor/31-schema-validation`
- The branch implements the issue created in step 1 (or multiple related issues)

### PR scope

- Each branch should implement related changes (one or more related issues).
- PRs CAN merge multiple related issues (e.g., two bugs in the same module).
- Do NOT bundle unrelated changes into a single branch/PR.
- If additional issues are discovered while implementing, create a separate issue and branch.
- Tests for the features being implemented belong in the same PR.

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

### 4. Test (local only — CI does not run on feature branches)

- Backend: `cd backend && uv run pytest` (when tests exist)
- Backend lint: `cd backend && uv run ruff check src/`
- Frontend lint: `cd frontend && npm run lint`
- Frontend build: `cd frontend && npm run build`
- Verify no regressions before pushing
- CI only validates on `dev` → `main` PRs — local testing is your gate

### 5. Push & PR (feature branch → dev)

```bash
git push origin <branch>
gh pr create \
  --title "<type>: <description>" \
  --body "<template>" \
  --label "<label per mapping table>" \
  --assignee fiwon123 \
  --base dev
```

- Fill out the PR template completely (`.github/pull_request_template.md`)
- Link the issue created in step 1: `Closes #<issue-number>`
- **Comment on the issue**: `gh issue comment <issue-number> --body "PR opened: #<pr-number>"`
- Work only in feature branches — never push directly to `dev` or `main`

### 6. Review & Merge (feature branch → dev)

- Self-review the diff for bugs, security, and regressions
- Only merge when explicitly instructed
- Prefer squash merge, then delete the branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
- After merging to `dev`:
  - **Comment on the issue**: `gh issue comment <issue-number> --body "Merged into dev — ready for release"`
  - **Comment on the PR**: `gh pr comment <number> --body "Merged into dev — thanks!"`
- **Always return to dev after merge**:
  ```bash
  git checkout dev
  git pull origin dev
  ```
- If a PR/branch is not necessary, close it with a comment explaining why

### 7. Release merge (dev → main) — User-initiated only

- **Do NOT automatically create release PRs or merge to main**
- The user must explicitly ask: "Can we merge dev to main?" or "Put this in production"
- Before requesting, verify that:
  - All milestone issues are complete
  - `dev` branch is stable (no failing tests, no regressions)
  - All feature branches for this milestone have been merged
- When user requests release:
  ```bash
  git checkout dev
  git pull origin dev
  git push origin dev
  gh pr create \
    --title "release: <milestone-name>" \
    --body "Release PR for milestone: <milestone-name>" \
    --label "release" \
    --base main
  ```
- CI runs automatically on this PR
- **Comment on the issue**: `gh issue comment <issue-number> --body "Release PR opened: #<pr-number>"`
- After CI passes:
  - **Comment on the issue**: `gh issue comment <issue-number> --body "CI passed — ready to merge to main"`
- **Ask user to confirm merge**: "CI passed. Ready to merge dev to main?"
- Only merge after user confirms:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
- After merging:
  - **Comment on the issue**: `gh issue comment <issue-number> --body "Released in <commit-sha>"`
  - **Comment on the PR**: `gh pr comment <number> --body "Released — thanks!"`
- **Always return to dev after release merge**:
  ```bash
  git checkout dev
  git pull origin dev
  ```

### 8. Cleanup

```bash
git checkout dev
git pull origin dev
git remote prune origin
```

- **Always end on `dev`** — this is the working branch with the latest integrated features
- Verify clean state: only `dev` remains locally and on the remote

### Environment Notes

- This project runs with the agent (opencode) **natively on the host**; the
  `docker compose` dev sandbox provides the app runtime (uvicorn + vite +
  arq worker + postgres/redis/minio) and is driven via `make`/`docker compose`
- Backend: Python 3.14 managed by `uv` — use `uv run`, never pip directly
- Frontend: Node 22 managed by `npm`
- `gh` CLI is authenticated natively on the host (`gh auth status`)
- Never access secret files (`.env`, etc.) without explicit permission
