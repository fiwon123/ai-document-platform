---
name: github-workflow
description: Git branching, commits, PRs, and GitHub workflow conventions
metadata:
  workflow: git-flow, conventional-commits
---

## GitHub Workflow Rules

### Branch Naming

Use the format: `<type>/<short-description>`

| Type | Use Case | Example |
|------|----------|---------|
| `feat` | New features | `feat/document-chunking` |
| `fix` | Bug fixes | `fix/auth-token-expiry` |
| `refactor` | Code refactoring | `refactor/search-service` |
| `docs` | Documentation | `docs/api-reference` |
| `test` | Adding tests | `test/document-upload` |

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

### Pull Request Workflow

1. Create feature branch from main
2. Make changes and commit
3. Push branch and create PR
4. Fill out PR template
5. Ensure tests pass
6. Request review
7. Address feedback
8. Merge (only when explicitly instructed)

### PR Rules

- NEVER push directly to main
- Always work in feature branches
- Run tests before opening a PR
- Write clear PR descriptions
- Link related issues
- Do NOT merge PRs unless explicitly instructed

### Issue References

Reference issues in commits and PRs:
- `fix: resolve timeout (#42)`
- `Closes #42`
- `Fixes #42`
