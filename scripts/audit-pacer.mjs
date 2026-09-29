/**
 * Rate-limit pacing decisions for the visual audit (#535).
 *
 * ## Why the audit paces at all
 *
 * The API rate-limits per client IP at 100 requests / 60 s, and the audit's
 * Chromium is one client. A full pass makes several hundred requests. Left
 * alone, the surplus comes back 429, and a 429 on `/v1/auth/me` or
 * `/v1/qa/models` is not a cosmetic nuisance: the app treats a failed
 * `/auth/me` as "no session" and redirects to `/login`, and a failed
 * `/qa/models` leaves the settings page with no model options. Both then look
 * exactly like a *UI regression* — an element is missing — which is the one
 * thing the audit exists to detect. The first full gated pass (#529) closed
 * with a `skips` finding for `/app/settings model-option-hover` that was
 * manufactured by the tool starving itself.
 *
 * ## The old, reactive design and why it failed
 *
 * The original `Pacer` was reactive: it only slept once a response had already
 * reported `X-RateLimit-Remaining: 0`. By the time it knew the window was
 * spent, the request that told it so — and any request already in flight from
 * the same tick — had already been counted against the cap and could come back
 * 429. It reacted to running out instead of stopping before it ran out.
 *
 * ## The design here
 *
 * Keep a **reserve**: when remaining drops to the reserve, stop and sleep out
 * the rest of the window *before* issuing the next request, so the limiter
 * never actually answers 429. `remaining` is refreshed from every response and
 * forgotten after a sleep, so the reserve is re-learned from reality each time
 * rather than guessed.
 *
 * The wait is `windowMs - elapsed` where `elapsed` is measured from the moment
 * the reserve was first hit, plus a small settle buffer. Sleeping a full window
 * from the reserve mark is correct for both a fixed-window and a
 * sliding-window limiter: by then every request we made before the mark has
 * either been replenished (fixed) or aged out (sliding), and either way at
 * least `reserve` slots are free. The `elapsed` term only shortens the wait
 * when the caller comes back to us partway through, never below the point
 * where the window has rolled.
 *
 * All of this is pure decision logic so it can be unit-tested without a
 * browser, a network, or a 60-second sleep. `audit.mjs` owns the I/O.
 */

/** The limiter's own default window; kept here so the pacer and docs agree. */
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Requests to leave unused in the tail of each window.
 *
 * Big enough to absorb the handful of requests a page fires in one tick (a
 * document list plus a status poll is 2; the settings page is several more),
 * small enough that the pass is not materially slower. The limiter answers 429
 * at exactly 0, so any reserve ≥ 1 helps; 12 is comfortably above any single
 * capture's burst.
 */
export const DEFAULT_RESERVE = 12;

/** Extra margin after the window rolls, for header propagation and clock skew. */
const SETTLE_MS = 500;

/** Below this, sleeping is not worth the wakeup; treat as a no-op decision. */
const MIN_SLEEP_MS = 1000;

/**
 * Decide how long to wait before the next request, from what we last observed.
 *
 * Pure: it reads the current `remaining`/`throttledAt` and `now`, and returns
 * the decision without sleeping or mutating. `Pacer.beforeRequest` applies it.
 *
 * @param {{remaining: number|null, throttledAt: number|null}} state
 * @param {{now: number, windowMs: number, reserve: number, minSleepMs?: number}} opts
 * @returns {{waitMs: number, reason: string}} `waitMs: 0` means "go now".
 */
export function planBeforeRequest(state, { now, windowMs, reserve, minSleepMs = MIN_SLEEP_MS }) {
  // No header seen yet — nothing to pace against. We could hammer, but the
  // limiter only exists to be respected, so on a fresh client we simply go.
  if (state.remaining === null) return { waitMs: 0, reason: "no-header" };

  // Comfortably above the reserve: the whole point of the reserve is that we
  // never spend these.
  if (state.remaining > reserve) return { waitMs: 0, reason: "headroom" };

  // At or below the reserve: this is the first request of the wait. Stamp the
  // moment we hit the reserve; elapsed is measured from here.
  if (state.throttledAt === null) {
    const waitMs = windowMs + SETTLE_MS;
    return { waitMs, reason: "reserve-hit" };
  }

  const elapsed = now - state.throttledAt;
  const waitMs = Math.max(0, windowMs - elapsed) + SETTLE_MS;
  return { waitMs, reason: waitMs > minSleepMs ? "waiting-out-window" : "short-wait" };
}

/**
 * Track the limiter header and apply {@link planBeforeRequest} before each
 * request. Lives here (not in the pure module) because it owns `Date.now` and
 * the sleep; the sleep function is injectable so tests never really wait.
 */
export class Pacer {
  constructor({ windowSeconds = DEFAULT_WINDOW_SECONDS, reserve = DEFAULT_RESERVE, sleep } = {}) {
    this.windowMs = windowSeconds * 1000;
    this.reserve = reserve;
    this.remaining = null;
    // When the reserve was first hit in the current window; null when we are
    // not throttled. Distinct from `remaining === 0` in the old design: this
    // starts counting at the reserve, not at exhaustion.
    this.throttledAt = null;
    this.sleptMs = 0;
    this.sleptWindows = 0;
    this._sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Update from a response's `X-RateLimit-Remaining` (or any headers bag). */
  observe(headers) {
    const raw = headers?.["x-ratelimit-remaining"];
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.remaining = value;
    // Back above the reserve means the window rolled; clear the mark so the
    // next descent is timed from scratch.
    if (value > this.reserve) this.throttledAt = null;
  }

  /** Pure decision — exposed so tests (and `--help`) can read the policy. */
  plan(now = Date.now()) {
    return planBeforeRequest(
      { remaining: this.remaining, throttledAt: this.throttledAt },
      { now, windowMs: this.windowMs, reserve: this.reserve },
    );
  }

  /**
   * Sleep out the window if we are at/below the reserve, then continue. Called
   * before each request. On a real sleep we forget `remaining` so the next
   * response repopulates it — the window that just rolled has a full budget.
   */
  async beforeRequest(now = Date.now()) {
    const { waitMs, reason } = this.plan(now);
    if (waitMs <= 0) return reason;
    if (reason === "reserve-hit") this.throttledAt = now;
    if (waitMs > MIN_SLEEP_MS) {
      this.sleptMs += waitMs;
      this.sleptWindows += 1;
      await this._sleep(waitMs);
      this.remaining = null; // re-learn after the window rolls
      this.throttledAt = null;
    }
    return reason;
  }
}

/**
 * Fold a run's recorded 429s into stable, reviewable findings.
 *
 * A 429 is *always* reported, never folded into a skip: the whole point of
 * #535 is that the tool must not blame the UI for starving itself. Each
 * distinct `what` (method + path) becomes one finding with a count, so three
 * 429s on `/v1/auth/me` is one line a human can act on, not three.
 *
 * @param {string[]} recorded raw `"429 GET /v1/auth/me"` strings
 * @returns {Array<{what: string, count: number}>} sorted by count desc
 */
export function rateLimitFindings(recorded) {
  const counts = new Map();
  for (const raw of recorded) {
    const entry = String(raw).trim();
    if (!entry.startsWith("429 ")) continue;
    // Key on method + path. The query string is dropped because a 429 is a
    // property of the endpoint, not of one request's parameters, and including
    // it would make an otherwise-identical finding look new on every capture.
    const what = entry.slice(4).split("?")[0];
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([what, count]) => ({ what, count }))
    .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what));
}
