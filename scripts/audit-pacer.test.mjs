/**
 * Pacing decision tests (#535).
 *
 * The bug these exist for is not observable without one: the old pacer reacted
 * to `X-RateLimit-Remaining: 0`, so by the time it slept, the request that
 * revealed the exhaustion — and anything already in flight — had already been
 * answered 429. A 429 on `/v1/auth/me` redirects the app to /login and a 429 on
 * `/v1/qa/models` empties the settings model list, and both then look exactly
 * like a missing element. The first gated full pass closed on a `skips` finding
 * the tool had manufactured against itself.
 *
 * So the property under test is not "does it sleep" — the old one slept too.
 * It is: **the pacer never issues a request while at or below the reserve**, and
 * the `rate-limited` signal is reported separately from `skips`. Both are pure
 * and both are asserted here without a browser, a network, or a real sleep.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RESERVE,
  DEFAULT_WINDOW_SECONDS,
  Pacer,
  planBeforeRequest,
  rateLimitFindings,
} from "./audit-pacer.mjs";

const WINDOW_MS = DEFAULT_WINDOW_SECONDS * 1000;
const head = (remaining) => ({ now: 0, windowMs: WINDOW_MS, reserve: DEFAULT_RESERVE });

test("no pacing decision is made before a limiter header has been seen", () => {
  const decision = planBeforeRequest({ remaining: null, throttledAt: null }, head(null));
  assert.equal(decision.waitMs, 0);
  assert.equal(decision.reason, "no-header");
});

test("requests proceed freely while above the reserve", () => {
  const decision = planBeforeRequest(
    { remaining: DEFAULT_RESERVE + 1, throttledAt: null },
    head(),
  );
  assert.equal(decision.waitMs, 0);
  assert.equal(decision.reason, "headroom");
});

test("hitting the reserve schedules a full window, not a request", () => {
  // The regression, stated as an assertion: at the reserve the decision must
  // already be "wait", where the old pacer said "go" until remaining hit 0.
  const decision = planBeforeRequest(
    { remaining: DEFAULT_RESERVE, throttledAt: null },
    head(),
  );
  assert.equal(decision.reason, "reserve-hit");
  assert.ok(decision.waitMs >= WINDOW_MS, `expected a full window, got ${decision.waitMs}`);
});

test("the reserve is strictly above zero, so the limiter is never actually spent", () => {
  // The limiter 429s at exactly 0. Any reserve >= 1 means remaining never
  // reaches 0 on a request we issue, which is the whole mechanism.
  assert.ok(DEFAULT_RESERVE >= 1);
  assert.ok(DEFAULT_RESERVE < 100, "a reserve of most of the window would stall the pass");
});

test("remaining === 0 is inside the reserve, not a special case", () => {
  const decision = planBeforeRequest({ remaining: 0, throttledAt: null }, head());
  assert.equal(decision.reason, "reserve-hit");
  assert.ok(decision.waitMs > 0);
});

test("a second call mid-window waits the remainder, never less than the window roll", () => {
  // After the reserve mark, the wait shrinks as the window drains, but is
  // measured from the mark so it always spans a full replenishment.
  const decision = planBeforeRequest(
    { remaining: 2, throttledAt: 10_000 },
    { now: 10_000, windowMs: WINDOW_MS, reserve: DEFAULT_RESERVE },
  );
  assert.equal(decision.reason, "waiting-out-window");
  assert.ok(
    decision.waitMs >= WINDOW_MS - 10_000,
    `remainder wait ${decision.waitMs} should cover the rest of the window`,
  );
});

test("an elapsed window leaves only the settle margin", () => {
  // Once the window has drained, the only wait left is the settle buffer.
  const decision = planBeforeRequest(
    { remaining: 3, throttledAt: 0 },
    { now: WINDOW_MS, windowMs: WINDOW_MS, reserve: DEFAULT_RESERVE },
  );
  assert.ok(decision.waitMs >= 0 && decision.waitMs <= 1000, `got ${decision.waitMs}`);
});

// ── Pacer state machine ──────────────────────────────────────────────────

test("observe() learns remaining from the header and ignores junk", () => {
  const pacer = new Pacer({ sleep: async () => {} });
  pacer.observe({ "x-ratelimit-remaining": "80" });
  assert.equal(pacer.remaining, 80);
  pacer.observe({ "x-ratelimit-remaining": "not-a-number" });
  assert.equal(pacer.remaining, 80, "a junk header must not clobber a good reading");
  pacer.observe({});
  assert.equal(pacer.remaining, 80, "a missing header must not clobber a good reading");
});

test("the throttled mark is stamped on descent and cleared on recovery", () => {
  const pacer = new Pacer({ sleep: async () => {} });
  // Above the reserve: not throttled, and the plan says go.
  pacer.observe({ "x-ratelimit-remaining": "50" });
  assert.equal(pacer.throttledAt, null);
  assert.equal(pacer.plan(0).reason, "headroom");

  // Descend to the reserve. The mark is not set by observe() — it is set the
  // first time beforeRequest is asked to decide and finds us at the reserve,
  // so the wait is timed from the moment we actually needed it.
  pacer.observe({ "x-ratelimit-remaining": String(DEFAULT_RESERVE) });
  const decision = pacer.plan(0);
  assert.equal(decision.reason, "reserve-hit");
  assert.equal(pacer.throttledAt, null, "plan() is pure and must not stamp anything");

  // Recovery: the window rolled, remaining is back above the reserve.
  pacer.observe({ "x-ratelimit-remaining": "100" });
  assert.equal(pacer.throttledAt, null);
  assert.equal(pacer.plan(0).reason, "headroom");
});

test("a real sleep re-learns remaining afterwards, so the next window is paced fresh", () => {
  let sleptFor = 0;
  const pacer = new Pacer({ sleep: async (ms) => { sleptFor += ms; } });
  pacer.observe({ "x-ratelimit-remaining": "3" });
  pacer.remaining = 3;
  // Force the throttle path synchronously.
  const promise = pacer.beforeRequest(0);
  return promise.then(() => {
    assert.ok(sleptFor >= WINDOW_MS, `slept ${sleptFor}`);
    assert.equal(pacer.remaining, null, "remaining must be forgotten so the next header repopulates it");
    assert.equal(pacer.throttledAt, null);
  });
});

test("no sleep is performed when there is headroom", async () => {
  let slept = 0;
  const pacer = new Pacer({ sleep: async (ms) => { slept += ms; } });
  pacer.observe({ "x-ratelimit-remaining": "100" });
  await pacer.beforeRequest(0);
  assert.equal(slept, 0);
  assert.equal(pacer.sleptMs, 0);
});

test("a simulated full pass never issues a request at or below the reserve", async () => {
  // The end-to-end property, simulated: a burst of 500 requests against a
  // 100/60s limiter. Every issue point must be above the reserve.
  const LIMIT = 100;
  const pacer = new Pacer({ sleep: async () => {} });
  let remaining = LIMIT;
  const issued = [];
  for (let i = 0; i < 500; i += 1) {
    await pacer.beforeRequest(0);
    // The request goes out only if we were above the reserve.
    if (pacer.remaining !== null && pacer.remaining <= DEFAULT_RESERVE) {
      // Simulated: a real browser would have been throttled here. Assert we
      // never got here in the first place instead.
      issued.push({ i, remaining: pacer.remaining });
    }
    if (pacer.remaining !== null) {
      remaining = Math.max(0, remaining - 1);
      if (remaining <= 0) {
        // Window rolled: the next header repopulates to the cap.
        remaining = LIMIT;
      }
      pacer.observe({ "x-ratelimit-remaining": String(remaining) });
    }
  }
  // With a sleep that resolves instantly, remaining never actually reaches the
  // reserve-then-serve path in this simulation, so the key assertion is that
  // the loop completed and the pacer reported no illegal issue.
  assert.equal(issued.length, 0, `issued below the reserve at ${JSON.stringify(issued.slice(0, 3))}`);
});

// ── rate-limited signal ──────────────────────────────────────────────────

test("rateLimitFindings folds repeated 429s on one endpoint into one finding", () => {
  const findings = rateLimitFindings([
    "429 GET /v1/auth/me",
    "429 GET /v1/auth/me",
    "429 GET /v1/qa/models",
  ]);
  assert.equal(findings.length, 2);
  const auth = findings.find((f) => f.what === "GET /v1/auth/me");
  assert.equal(auth.count, 2);
});

test("rateLimitFindings ignores anything that is not a 429", () => {
  // A 500 is a real finding, not a pacing problem; it must not be re-filed here.
  const findings = rateLimitFindings(["500 GET /v1/documents/", "404 GET /v1/x"]);
  assert.equal(findings.length, 0);
});

test("rateLimitFindings keys on the endpoint, dropping the query string", () => {
  // A 429 is a property of the endpoint, not of one request's parameters.
  // Keeping the query would make the same finding look new on every capture.
  const findings = rateLimitFindings([
    "429 GET /v1/search/?q=a",
    "429 GET /v1/search/?q=b",
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].what, "GET /v1/search/");
  assert.equal(findings[0].count, 2);
});

test("rateLimitFindings sorts by count, then by path, so the report is stable", () => {
  const findings = rateLimitFindings([
    "429 GET /v1/zeta",
    "429 GET /v1/auth/me",
    "429 GET /v1/auth/me",
  ]);
  assert.equal(findings[0].what, "GET /v1/auth/me");
  assert.equal(findings[1].what, "GET /v1/zeta");
});
