---
name: github-workflow
description: Git branching, commits, issues, PRs, and GitHub workflow conventions
metadata:
  workflow: git-flow, conventional-commits
---

## GitHub Workflow Rules

### End-to-End Tracking

Every change is tracked on GitHub: **issue → branch → PR → merge**.

1. **Create an issue** before writing any code (assigned + labeled)
2. **Create a branch** from main that implements exactly that issue
3. **Open a PR** linked to the issue (`Closes #N`, assigned + labeled)
4. **Comment at every milestone** (issue created, PR opened, CI passed, merged)
5. **Merge** only when explicitly instructed, then comment

### Assignee

- All issues and PRs are assigned to `fiwon123`.

### Label Mapping

Match the label to the commit type:

| Commit type | GitHub label |
|-------------|--------------|
| `feat`      | `enhancement` |
| `fix`       | `bug` |
| `chore`     | `chore` |
| `refactor`  | `refactor` |
| `docs`      | `documentation` |
| `test`      | `test` |
| `ci`        | `ci` |

Create the label if it does not exist yet:

```bash
gh label create <name> --color <hex> --description "<description>"
```

### Branch Naming

Use the format: `<type>/<short-description>`

| Type | Use Case | Example |
|------|----------|---------|
| `feat` | New features | `feat/document-chunking` |
| `fix` | Bug fixes | `fix/auth-token-expiry` |
| `refactor` | Code refactoring | `refactor/search-service` |
| `docs` | Documentation | `docs/api-reference` |
| `test` | Adding tests | `test/document-upload` |
| `chore` | Tooling/maintenance | `chore/ci-workflow` |
| `ci` | CI/CD changes | `ci/faster-builds` |

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]

[optional footer]
```

Examples:
- `feat: add document chunking endpoint`
- `fix: resolve auth token expiry issue`
- `refactor: extract search logic into service`
- `docs: update API reference`
- `test: add unit tests for document service`

### Issues

```bash
# Create an issue (before any branch or code)
gh issue create \
  --title "<type>: <short description>" \
  --body "<problem statement / acceptance criteria>" \
  --label "<label per mapping table>" \
  --assignee fiwon123

# Comment on an issue at each milestone
gh issue comment <number> --body "🔍 Starting work on this"
gh issue comment <number> --body "🔗 PR opened: #<pr-number>"
gh issue comment <number> --body "✅ CI passed — ready to merge"
gh issue comment <number> --body "🎉 Merged in <commit-sha>"
```

### Pull Requests

```bash
# Open a PR linked to its issue
gh pr create \
  --title "<type>: <description>" \
  --body-file <path> \
  --label "<label per mapping table>" \
  --assignee fiwon123

# Comment on the PR
gh pr comment <number> --body "<message>"

# Edit an existing PR (assignee/labels)
gh pr edit <number> --add-assignee fiwon123 --add-label "<label>"

# Check CI status before merging
gh pr checks <number> --watch

# Merge (only when explicitly instructed)
gh pr merge <number> --squash --delete-branch
```

### Pull Request Workflow

1. Create issue (assigned + labeled), comment `🔍 Starting work on this`
2. Create feature branch from main
3. Make changes and commit
4. Push branch and create PR (assigned + labeled, `Closes #N`)
5. Comment on issue: `🔗 PR opened: #<pr-number>`
6. Fill out PR template
7. Ensure CI passes, comment on issue: `✅ CI passed — ready to merge`
8. Merge only when explicitly instructed (squash + delete branch)
9. Comment on issue: `🎉 Merged in <sha>` and on PR: `Merged — thanks!`

### PR Rules

- NEVER push directly to main
- Always work in feature branches
- Run tests before opening a PR
- Write clear PR descriptions
- Link related issues with `Closes #N`
- One feature per PR — never bundle unrelated changes
- Do NOT merge PRs unless explicitly instructed

### Issue References

Reference issues in commits and PRs:
- `fix: resolve timeout (#42)`
- `Closes #42`
- `Fixes #42`

The issue auto-closes when its PR is merged via `Closes #N`.