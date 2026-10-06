Automated by the `uv lock upgrade` workflow (#696).

## What

`uv lock --upgrade` regenerated `backend/uv.lock` to the newest versions
the `pyproject.toml` constraints admit.

## Why not dependabot

Dependabot's `pip` ecosystem edits `pyproject.toml` only and never
regenerates `uv.lock`, so its backend PRs arrive unmergeable until a human
runs `uv lock`. This PR carries a consistent lockfile, and the backend suite
already passed against it in the workflow that opened this PR. Any open
dependabot pip PR for `/backend` is superseded by this one — close it
instead of merging it.

## Gotchas

- A lock that syncs but breaks the suite is never opened as a PR — the
  workflow runs `uv sync --locked && uv run pytest` first and fails loudly.
- Verify with `cd backend && uv sync --locked` before merging.

To apply unpinned upstream without waiting for the schedule:
`cd backend && uv lock --upgrade` locally and push the result.