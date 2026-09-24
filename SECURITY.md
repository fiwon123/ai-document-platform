# Security Policy

The AI Document Intelligence Platform handles user documents, API keys, and
authentication credentials, so security is taken seriously.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately to the maintainers by email. Include as much of the
following as possible:

- Affected component (backend/frontend/infra) and version or commit
- A description of the vulnerability and its impact
- Steps to reproduce (minimal, if possible)
- Any proof-of-concept or suggested fix

### Expected response

- **Acknowledgement**: within 48 hours of receipt
- **Initial triage**: within 5 business days (confirmed / not reproducible /
  won't fix / out of scope)
- **Fix timeline**: communicated once triaged; depends on severity

We ask that you give the maintainers a reasonable window to fix the issue and
ship a release *before* disclosing it publicly (standard coordinated
disclosure, typically 90 days for high/critical severity).

## Supported versions

| Version | Supported |
|---------|-----------|
| dev (integration branch) | ✅ (active development) |
| main (release) | ✅ |
| Older releases | ❌ (N-1 best-effort only) |

## Security considerations for contributors

- Never commit secrets: `.env`, `.env.*`, tokens, API keys, or passwords — the
  backend env file is gitignored by design, and `.dockerignore` excludes env
  files from image layers
- Any change that touches authentication, authorization, rate limiting, CORS,
  or secrets handling must include tests and be flagged in the PR description
- User documents and data must stay isolated per owner — cross-user leaks are
  critical severity
- Follow the branch strategy and PR review workflow in `CONTRIBUTING.md`