# Global Project Memory (Major)

> Read at session start, update during the session, archive + rotate at session end.
> Keep under ~200 lines. Local only (gitignored). Rules: `.opencode/instructions/memory.md`.
>
> **Layout**: this file is project *state* and an index. The accumulated engineering
> traps live in `lessons.md` (the CSS/probe/testing encyclopedia) — read or update it
> when a task touches layout, measurement, or test guards. State the pointer, don't
> inline the detail here.
> **Archive**: `archive/interaction-N.md`, **highest number = most recent** (the
> convention the files themselves follow, though `memory.md` says "1 = most recent");
> three files are kept.

## Project Status
- **2026-09-28** (Session #42). `dev` == `origin/dev` == `185a3da` — the security audit
  chain is merged: #516/#517, #518/#519, #520/#521, #522/#523, #524/#526, all squash-merged
  and all issues closed **by hand**. Working tree clean on `dev`; only `origin/dev` and
  `origin/main` remain remote. **No PR is open right now.**
- **Open follow-ups**: #525 (staging needs a real JWT secret injected — blocked on cluster
  access) and #527 (docs claim Infra CI runs on `dev` pushes; it does not).
- **Milestone**: **v0.10 - Free & Local AI Providers**. Also open: **v0.9 - Visual
  Regression Gating** (1 issue — check before filing new visual work).
- **Stack**: FastAPI + React 19 + PostgreSQL/pgvector + Redis/arq + MinIO/S3.
- **Branches**: `dev` (working branch) and `main` (untouched, far behind — left for the user).
- **Suite**: on `dev` **639 backend** (ruff clean on `src` + `tests`), frontend 637 vitest
  (49 files) + 74 audit-baseline script tests, oxlint + build clean.


## Completed programme: 7-phase polish (user-approved 2026-09-26, all merged)
Modernised **all pages at once**, each as its own issue/branch/PR: dark-mode app bar (#438),
desktop 900→1200px (#440), navbar overflow + touch targets (#443/#442), footer newsletter
feedback (#446), Groq primary + local fallback (#448), real feature testing → #451–#454
(keyword search now really searches, QA tiers honest, `score` documented, compose takes
provider config), and phase 7 superseded by v0.10 with #458–#460 all closed.

Standing user constraints: **no dedicated GPU — do not saturate the machine with local
models**; verify every visual change in **both** themes. Legal pages still carry
`*.example` placeholders.

## Active programme: v0.10 — Free & Local AI Providers

Make the zero-cost AI path real. #448 (Groq-primary), #454 (sandbox config pass-through) and
#486 (host Ollama reachable, Groq free-first default) are merged.

| # | Work | State |
|---|---|---|
| #488 | Local **embedding** provider | ✅ merged as `271be7c` — 473/587 + real E2E 13/13, 9/9 |
| #489 | Rate limit 100/60s **per IP** vs Groq's 30 RPM org-wide; a provider 429 is indistinguishable from a dead provider | PR #498 open |
| #495 | `DELETE /v1/users/me` erased nothing while returning 204 | ✅ merged as `accd6cb` |

**#488's layout is settled and merged** — one column per embedding *space*: `embedding` stays
`vector(1536)` with its ivfflat index (no change for anyone with an OpenAI key),
`embedding_local` is unconstrained for Ollama's widths, and `embedding_model` per row is the
filter that makes a same-width model swap visible. Existing 523 chunks keep
`embedding_model = NULL` (not relabelled with a guess), so they are not vector-searchable
until re-embedded — a re-embed tool is a separate issue, not part of #488. **Full derivation,
the three pgvector errors, the `create_all`-vs-migration trap and the E2E design rules are in
`lessons.md`.**

**The host is not a fresh machine assumption** — as of 2026-09-28 there is a real
Ollama 0.34.4 on it, reachable from the sandbox only via
`host.docker.internal:11434` (not bound to loopback; see `lessons.md`). `tinyllama`,
`qwen2.5-coder:1.5b` and `llama3.2:3b` are pulled, so a real end-to-end run costs
seconds of CPU — but it generated at **~1 tok/s** under load, so keep `QA_MAX_TOKENS`
low and do not benchmark quality from it.


## Standing Rules (from the user)
- **NEVER merge `dev` → `main`.** `dev` is the permanent trunk; all work is feature-branch
  → `dev`. So a dev-targeted `Closes #N` **never auto-closes**: every merged issue must be
  closed and commented **by hand**.
- **Never merge a PR without explicit authorisation.** One feature per PR; new problems
  found mid-implementation get their own issue.
- **Visual verification is now possible (2026-09-28, user-directed).** The old rule was
  "I cannot view screenshots — every visual claim must come from a number." That is
  **replaced**: build/visual work runs on a multimodal model (MiMo-V2.6-Flash Free),
  so screenshots, GIFs and video frames can be inspected directly. Numbers still
  matter for *measurements* (layout, timing, counts) — a screenshot is evidence of
  what a page looks like, not of a pixel value. The visual agent is marked **yellow**
  so it is distinguishable from the build agent.
- **Decisions taken by the user (2026-09-26)**: accept **keyword-only** search as a supported
  degraded mode; squash-merge is fine; fixing #451 with **PostgreSQL full-text search** is the
  chosen approach. "Keep hosted embeddings, no local embedding model" (#449) **held through
  v0.9 and was superseded by the v0.10 milestone the user approved**, which explicitly asks
  for a local embedding provider — #488. Keyword-only mode stays supported either way; OpenAI
  remains the default space whenever a key is configured.

## Phase 6 findings (real feature testing) — all resolved, kept as a record
- **#451 keyword search ignored the query** — filtered nothing, ordered by `chunk_index`,
  hardcoded `score=0.0`, so every query returned the user's first N chunks and every chip read
  a green "100% match". Now `to_tsvector`/`websearch_to_tsquery` + `ts_rank`, a substring
  fallback and a GIN index (migration 007).
- **#452** unconfigured-QA hint named only paid OpenAI. **#453** shipped a cosine distance as
  `score` undocumented (`score` is a **distance in [0, 1]**, lower = closer; UI renders
  `1 - score`; CSV heads it `distance` + `match_percent`). **#454** compose declared its whole
  environment inline, so no LLM provider variable could be set at all — fixed, and
  `tests/test_compose_env.py` now pins the pass-through *and* defaults against the code's own.
- **#458/#459/#460** (contrast, target sizes, missing `<main>`) — all closed.

The through-line, now repeated in `lessons.md`: **every one of these looked fine and none
threw an error.** A wrong default, a mislabelled tier and a dead config are all invisible
until something is measured or a test asserts the specific defect.

**Verified earlier, no longer assumed:** **Webhook delivery E2E 31/31** — real signed POST
verified by HMAC against raw bytes, retry ladder 500→500→200 with backoff, `failure_count`
persistence/reset, permanent failure over the real internet. The SSRF guard refuses loopback,
RFC1918, `169.254.169.254` and `file://`, and `_deliver` re-checks before every POST — so a
local receiver needs the guard bypassed *in the harness only*. **#488 E2E 13/13 + 9/9** on a
real host Ollama 0.34.4 (`lessons.md`). **#495 E2E**: register→upload→process→search→
subscribe→delete, with the file *and* the PDF thumbnail confirmed present in MinIO before
deletion and absent after — a mocked object store proves nothing about the bucket.

## Lessons index (`lessons.md`)
- **Targets & clipping** — the 23.2px line box under WCAG 2.5.8; 2.5.8 measures the
  *target* not the control; 44px only inside a component's own collapse band; a
  descendant combinator matching nothing; min-content floors clipped by `overflow: hidden`.
- **Sweeps & rate limits** — 2 `/auth/me` per page load against a 100/min cap makes a
  broken page report a false PASS; assert identity on every probe.
- **Layout budgets** — flex rows fail sideways not downwards; `slack` instead of `deficit`;
  `min-content` hides deficits; the two navbars have independent budgets.
- **Test guards** — a no-op mutation looks like a passing guard; a "passing" mutation may
  be a broken mutation; pin invariants not values; `?raw` is empty for CSS under vitest;
  **a test written from the old code can encode the bug it should have caught** (see
  #451's pagination test, which asserted document order).
- **Design tokens** — a token pair that inverts is a trap (check the *other* theme);
  a bar's own colour never registers as a hover wash.
- **React/app** — `flushSync` + lazy route = whole-page blank; `startTransition` instead.
- **Environment & git** — ports inside the container, Playwright absolute path, the
  read-only `~/.gitconfig` fix, `git cherry` (not `--is-ancestor`) for squash-merged
  branches, and the GitHub `UNKNOWN` mergeable trap.
- **Keyless LLM testing** — the OpenAI SDK honours `OPENAI_BASE_URL`, so a local stub on
  `127.0.0.1:11499` + `OPENAI_API_KEY=stub-local-key` exercises the *real* pgvector and QA
  paths with no paid key. Isolate by **port** (8010) but keep the **same** `REDIS_DB` as the
  running worker for anything involving an upload — a job on another DB is never picked up.
- **Postgres text search** — an empty tsquery (stopword-only query) matches nothing, so a
  "no results → fall back" path can quietly match everything; ask the dictionary which terms
  carry lexemes instead of hardcoding stopwords. `VALUES` with an empty list emits invalid
  SQL. An expression index is only used when the query repeats it byte-for-byte, so build it
  once in a shared helper *and* mirror it in the model so autogenerate doesn't drop it.
- **A provider that falls back hides its own failure** (#486) — a container reaching a host
  service needs *both* a resolvable name (`extra_hosts: host-gateway`, Desktop-only otherwise)
  and a non-loopback bind (a daemon setting, not an app one); a silent fallback means every
  gap surfaces as "it worked", so run the E2E with only the provider under test configured
  and print the client objects, not just the outcome.
- **pgvector can only index one width** (#488) — three measured refusals, so a
  shared unconstrained column can hold both providers but is unindexable, and one
  width-typed column rejects the other outright. The answer is one column per
  embedding space, which also keeps the existing index. `embedding_model` per row
  is load-bearing, not bookkeeping: two 1536-wide models are indistinguishable to
  the type, to a width check and to the database, and cosine distance across spaces
  returns a confident wrong number.
- **A `create_all` test fixture does not test the migration** (#488) — every
  schema assertion in the suite builds its DB from the model, so a wrong migration
  leaves it fully green. Check a migrated database separately; "the suite is green"
  is not evidence a new migration is right.
- **A failed statement poisons the session** — a vector-query error inside a
  `try` leaves the transaction aborted, so the fallback fails too with "current
  transaction is aborted" and the request 500s anyway with a more confusing
  message. Any fallback reusing the session must `rollback()` first.
- **A search E2E must ask a paraphrase, and its negative case must be same-user**
  (#488) — user scoping excludes another owner's rows, so a cross-space negative
  seeded elsewhere proves nothing. Asserting the `mode` string certifies the
  label, not the behaviour.
- **A cascade can be promised in a docstring and not exist** (#495) — `UserDB` has
  no relationships and `documents.owner_id` has no FK, so `DELETE /v1/users/me`
  returned 204 and left the data. No test seeded a document first, so CI was green —
  a deletion test with nothing to delete proves only that deleting nothing works.
  **Two more lessons from the fix:** (a) *verify a regression test fails without the
  fix* — 8/12 failed on reverted cascades, 3/12 with only the storage half removed,
  so neither half was passing vacuously; (b) *seed a real second account* — two
  existing tests seeded a bare UUID, which the new FK correctly rejected, and the
  correct fixture was a stranger who actually exists.

## Open / Blocked
- [x] **#516 / PR #517** (merged as `73b0fa9`, closed) — refresh rotation did
      not detect reuse and logout revoked nothing, though both were documented as
      working. `refresh_sessions` keyed by `jti` (migration 010): login records,
      refresh retires, logout revokes, retirement is a conditional UPDATE so
      concurrent refreshes cannot both mint a successor, legacy tokens adopted
      *and retired*, cascade on delete, daily sweep. Also fixed the cookie scope —
      it was `/v1/auth/refresh`, so a browser never sent it to
      `/v1/auth/logout`. `alembic upgrade head` required before use.
- [ ] **#518 / PR #519 OPEN (not merged, awaiting authorization)** — a password
      change evicted nobody, so the standard response to a suspected compromise did
      nothing. Deactivation was verified *already* effective (it re-reads
      `is_active` per request); a password change leaves the account active, so
      only the session rows can catch it. Revokes all live sessions, caller's own
      included (user chose that over identifying the caller, which the
      `/v1/auth`-scoped cookie makes impossible); username and rejected changes
      revoke nothing; revocation runs before the hash is written, so it fails
      closed. Chain revocation on a detected replay stays a separate policy call.
- [x] **#489 / PR #498** (merged, closed) — a per-provider budget enforcing
      Groq's org-wide 30 RPM **and** 200K tokens/day, and a real `429
      provider_rate_limited` (`source: app|provider`) instead of the generic 200 that
      a dead provider also produced. The E2E found the OpenAI SDK was retrying 429s
      behind our back — 34.2s and three requests against an exhausted allowance;
      `max_retries=0` made it 0.64s. See the lessons below.
- [x] **#499 / PR #501** (merged, closed) — the UI dropped the rate-limit contract #489
      added; a rate limit is now its own amber `role="status"` notice and the
      internal provider id is kept off the user's screen. `/v1/qa/models` returns
      `quotas` that no UI still reads (deliberately out of scope for #499).
- [ ] 523 chunks from pre-008 rows are deliberately invisible to vector search
      (`embedding_model IS NULL`); a re-embed/backfill tool is the follow-up and
      needs its own issue.
- [ ] **`main` is far behind `dev`** and v0.10 is now the active milestone. The 15 open
      Dependabot PRs all target `main`, so they are against a stale tree. **A `dev` -> `main`
      release is the obvious next step and needs the user's explicit go-ahead** (per
      `.opencode/instructions/workflow.md`).

- [ ] **#485 OPEN** — #474's residue: `carousel-hover` (4 combos) and `desktop-light-hero` vary
      by ≤0.55% with byte-identical DOM. **Reduced motion is NOT the fix — measured and
      reverted**: `reducedMotion: "reduce"` went 5/28 flaky → **9/28** (fixed 3 carousel, broke
      7 light captures); the new variance is text antialiasing, not geometry, and appeared in
      one run. Remaining: `deviceScaleFactor: 2` for the group (unmeasured), or accept + document.
- [ ] A real `POST /v1/newsletter/` endpoint was left out of #446 on purpose — offer it if
      the user wants the footer form to actually work.
- [ ] Phase 7 all-page polish sweep: not started. Also open: `/app/admin` mobile table
      horizontal scroll so Delete is reachable.
- [ ] Optional: a CI job for the signal gate. CI runs only on `main`-targeted PRs with the
      `ci` label and uses no Docker; pixel diffing must never be a CI gate.
- Dependabot PRs are open and untouched (16, all targeting the stale `main`).

## Recently closed (lessons in `lessons.md`)
- **#475** (pixel diffing, `--pixel-baseline=DIR`) and **#474 / PR #484** (capture
  determinism, 10/28 → 5/28 flaky) merged to `dev`, closed by hand. #484 also fixed a CI
  gap: `package.json` duplicated the audit test-file list, so `make test` would have
  skipped the new tests.
- **#471 / PR #473** — 5 AA contrast failures, one root cause: a *fill* token used as a
  *foreground* (`.match-ok`, `.match-bad`, `.error-message`). The light `.error-message`
  case at 4.41:1 passes review by eye and fails every automated check; the dark case points
  the other way and needs a **lighter** red, so it is a token swap and not "one step
  darker". `scripts/audit-baseline.json` is back to `"findings": []` — the audit is clean,
  not merely quiet.
- **#469 / PR #472** — the signal gate (`--gate`, committed baseline, `gate-report.json`,
  `make gate-ui`).
- Milestone `v0.9 - Visual Regression Gating`: #469, #471, #474, #470, #475 all closed.
  All 8 prior milestones closed.

## Closed work (lessons kept in `lessons.md`)
- **Sandbox + QA reliability, 4 PRs (#476, #478, #480, #482)** — each looked green locally
  and was not: `make shell`/`make opencode` rebuilt the sandbox every call; QA tests inherited
  the developer's real LLM credentials; a blank or misspelled `OPENAI_MODEL` 500'd **every**
  question in any hand-rolled/K8s/Helm deployment (compose's `${OPENAI_MODEL:-gpt-4}` default
  hid it).
- **#495 / PR #497** (`accd6cb`) — account deletion erased nothing; only `webhook_subscriptions`
  had `ON DELETE CASCADE` to `users`. Fixed with DB-level cascades on `documents.owner_id` +
  `search_history.user_id` (columns, **not** relationships) and best-effort object cleanup.
  Evidence: 7 orphan rows. **#488 / PR #496** (`271be7c`) — the embedding-space filter, where
  `embedding_model` is load-bearing beyond bookkeeping: two OpenAI models are **both** 1536-wide,
  so a same-space swap is invisible to a width check and returns a confident *wrong* distance.
- **The same shape twice**: DELETE on a *ready* document 500'd (`NotNullViolation`) because the
  ORM backref nullified loaded children before the DB cascade — `passive_deletes=True`; and no
  prior delete test seeded chunks, so the suite stayed green. Hence #495's rule: cascades on
  **columns, not relationships**, and delete tests must seed children.
- #352 **ETag cache staleness** (`max-age=60` let the *browser* serve a stale
  `/v1/statistics/me`; fixed to `private, no-cache`).
- **Phase 5 / #448** (keyless local LLM path, Groq-first order), **#449** (keep hosted
  embeddings, support keyword-only mode), the 8-PR accessibility batch (#416–#427), v0.4–v0.6
  + UI rounds 1–3 (#323–#393, #400–#411), and **#424** (measurement amended an impossible
  criterion). All closed **by hand**.
