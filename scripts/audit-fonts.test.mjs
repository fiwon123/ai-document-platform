/**
 * Unit tests for the capture font gate (#537).
 *
 * The bug: `settleVisuals()` awaits `document.fonts.ready`, and a capture still
 * came out in a fallback typeface — because the page loads its faces through a
 * CSS `@import`, so at the moment the wait resolves there is nothing pending:
 * the faces are not registered yet. `document.fonts.ready` cannot see a load
 * that has not started.
 *
 * The invariants under test, in order of how much damage getting them wrong
 * would do:
 *
 * 1. **Never photograph a fallback face.** A capture that is ready only when
 *    both a loaded face exists *and* the text measures differently from the
 *    fallback. A face registered but not applied, or applied but not
 *    registered, is both not ready.
 * 2. **Report the failure, do not throw.** A gate that cannot decide returns
 *    `{ ready: false }` with a reason naming each family and its status, and
 *    the caller skips. A run that dies here captures nothing at all.
 * 3. **Give up in bounded time.** The cap is honoured, and the wait reports how
 *    long it spent so a slow page is distinguishable from a broken one.
 * 4. **Do not reintroduce `document.fonts.check()`.** It returns *true* when
 *    the family is absent from the document's font list — true precisely when
 *    nothing is loaded, which is the case this gate exists to catch. The last
 *    test pins that the probe does not depend on it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FONT_CAP_MS,
  REQUIRED_FAMILIES,
  classifyFontState,
  waitForFonts,
} from "./audit-fonts.mjs";

/**
 * A page where every family is loaded and visibly applied.
 *
 * `faces` is a *list* of statuses per family, because that is the real shape:
 * the Google Fonts stylesheet registers one face per unicode-range subset, and
 * a healthy page has most of them sitting at `unloaded` — unneeded, not
 * missing. Measured live: 26 Manrope faces on /pricing, one of them loaded.
 */
const loaded = () => ({
  faces: {
    Manrope: ["unloaded", "unloaded", "loaded", "unloaded"],
    "DM Mono": ["unloaded", "loaded"],
  },
  widths: {
    Manrope: { web: 512.4, fallback: 601.1 },
    "DM Mono": { web: 693.2, fallback: 601.1 },
  },
  documentFontStatus: "loaded",
});

/** A page in the fallback face: the @import has not been applied at all. */
const fallback = () => ({
  faces: { Manrope: null, "DM Mono": null },
  widths: {
    Manrope: { web: 601.1, fallback: 601.1 },
    "DM Mono": { web: 601.1, fallback: 601.1 },
  },
  documentFontStatus: "loaded",
});

/** A page mid-load: registered, still fetching. */
const pending = () => ({
  faces: { Manrope: ["loading", "loading"], "DM Mono": ["loading"] },
  widths: {
    Manrope: { web: 601.1, fallback: 601.1 },
    "DM Mono": { web: 601.1, fallback: 601.1 },
  },
  documentFontStatus: "loading",
});

test("a page in its real typeface is ready", () => {
  const verdict = classifyFontState(loaded());
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.missing, []);
  assert.equal(verdict.reason, null);
});

test("the fallback face is not ready, and the reason says so", () => {
  const verdict = classifyFontState(fallback());
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /^fonts not ready: /);
  // "absent" is the diagnosis an operator needs: the stylesheet never arrived,
  // which is a different problem from a slow font.
  assert.match(verdict.reason, /Manrope \(absent\)/);
  assert.match(verdict.reason, /DM Mono \(absent\)/);
});

test("a mid-load face is not ready either", () => {
  const verdict = classifyFontState(pending());
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /Manrope \(loading\)/);
});

test("a loaded face that is not what renders is not ready", () => {
  // The unicode-range / failed-swap case: `document.fonts` says loaded, the
  // screen shows the fallback. Trusting the bookkeeping here would reproduce
  // #537 with the gate in place, which is worse than no gate.
  const observation = loaded();
  observation.widths.Manrope = { web: 601.1, fallback: 601.1 };
  const verdict = classifyFontState(observation);
  assert.equal(verdict.ready, false);
  // The status is still reported honestly — the face *is* loaded, and that is
  // the part an operator would otherwise chase.
  assert.match(verdict.reason, /Manrope \(loaded\)/);
});

test("a partial page is not ready, and names only the family that is wrong", () => {
  const observation = loaded();
  observation.faces["DM Mono"] = null;
  observation.widths["DM Mono"] = { web: 601.1, fallback: 601.1 };
  const verdict = classifyFontState(observation);
  assert.equal(verdict.ready, false);
  assert.deepEqual(verdict.missing, ["DM Mono (absent)"]);
  assert.doesNotMatch(verdict.reason, /Manrope/);
});

test("one loaded subset face is enough, however many siblings sit unloaded", () => {
  // The bug this test exists to prevent was found by running the gate against
  // the live sandbox, not by reading it: the probe read the *first* face for
  // the family, which on a real page is a subset the page's text does not use
  // and which is therefore permanently `unloaded`. Every capture was skipped —
  // 169 of them — for a page that was rendering Manrope correctly. A gate that
  // refuses every photograph is not a gate, it is an outage.
  const observation = loaded();
  observation.faces.Manrope = Array.from({ length: 25 }, (_, i) =>
    i === 7 ? "loaded" : "unloaded"
  );
  const verdict = classifyFontState(observation);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.reason, null);
});

test("a family registered but with nothing loaded is not ready, and says 'loading'", () => {
  // The direction that keeps the "any face" reduction honest: an all-unloaded
  // family has not rendered, and the message must distinguish it from a family
  // that was never registered at all ("absent" means the stylesheet has not
  // arrived — a different problem, and a different fix).
  const observation = loaded();
  observation.faces.Manrope = ["unloaded", "unloaded"];
  const verdict = classifyFontState(observation);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reason, /Manrope \(loading\)/);
  assert.doesNotMatch(verdict.reason, /absent/);
});

test("an absent or malformed observation is not ready rather than a throw", () => {
  // A navigation mid-probe throws inside the page. Every caller needs the same
  // answer to a question it must ask again, so this is total by construction.
  for (const bad of [undefined, null, {}, { faces: null }, { widths: 7 }, "nonsense"]) {
    const verdict = classifyFontState(bad);
    assert.equal(verdict.ready, false);
    assert.equal(typeof verdict.reason, "string");
  }
});

test("a width that is not a number is not treated as applied", () => {
  const observation = loaded();
  observation.widths.Manrope = { web: NaN, fallback: 601.1 };
  assert.equal(classifyFontState(observation).ready, false);
});

test("the required families are the ones the app's CSS declares", () => {
  // If the app's fonts change, this fails rather than silently gating on a
  // family that no longer exists (which would leave a capture in the fallback
  // and report it as ready).
  assert.deepEqual([...REQUIRED_FAMILIES].sort(), ["DM Mono", "Manrope"]);
});

test("the wait drains pending loads, then reports a fallback page as not ready", async () => {
  const calls = [];
  const verdict = await waitForFonts(
    {},
    {
      capMs: 0,
      evaluate: async (fn, arg) => {
        // The first call is `document.fonts.ready`; the rest are probes.
        if (arg === undefined) {
          calls.push("drain");
          return undefined;
        }
        calls.push("probe");
        return fallback();
      },
      waitForTimeout: async () => {},
      now: () => 0,
    }
  );
  assert.deepEqual(calls, ["drain", "probe"]);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.capped, true);
});

test("the wait returns as soon as the faces are applied, without spending the cap", async () => {
  const sequence = [fallback(), pending(), loaded()];
  let call = 0;
  const sleeps = [];
  let clock = 0;
  const verdict = await waitForFonts(
    {},
    {
      evaluate: async (fn, arg) => {
        if (arg === undefined) return undefined;
        const next = sequence[Math.min(call, sequence.length - 1)];
        call += 1;
        return next;
      },
      waitForTimeout: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    }
  );
  assert.equal(verdict.ready, true);
  assert.equal(verdict.capped, false);
  // Three probes, two sleeps between them, and no third sleep after the last:
  // the loop returns on ready, it does not wait out the clock.
  assert.equal(sleeps.length, 2);
  assert.equal(verdict.waitedMs, clock);
});

test("the wait is bounded, and reports how long it spent", async () => {
  // A page that never loads its fonts must not hang the run: the cap is the
  // difference between a skipped capture and a run with no captures.
  let clock = 0;
  const verdict = await waitForFonts(
    {},
    {
      capMs: 500,
      pollMs: 100,
      evaluate: async (fn, arg) => (arg === undefined ? undefined : fallback()),
      waitForTimeout: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.capped, true);
  // It stops at the first observation *past* the cap, so the overshoot is at
  // most one poll interval.
  assert.ok(clock >= 500 && clock <= 500 + 100, `waited ${clock}ms`);
});

test("a probe that throws is not ready, and the wait still terminates", async () => {
  // The page navigated between the drain and the probe. That must cost one
  // capture, not the run.
  let clock = 0;
  const verdict = await waitForFonts(
    {},
    {
      capMs: 200,
      pollMs: 50,
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
      waitForTimeout: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.capped, true);
  assert.ok(clock <= 200 + 50);
});

test("the default cap outlasts a measured cold load, and cannot hold up a run", () => {
  // Both bounds come from measurements, not taste.
  //
  // Lower bound: a cold load in the dev container takes 3.0–3.6s (the
  // `@import` stylesheet, then the font files). A cap under that skips the first
  // capture of a cold run — the same failure as refusing every capture, only
  // harder to spot because the rest of the run looks healthy.
  //
  // Upper bound: the wait ends when the faces are applied, so a generous cap
  // costs nothing on a healthy page. What it must not do is turn one page whose
  // fonts never arrive into a stalled run: 169 captures in a full pass means a
  // cap in minutes is a cap on the whole run.
  assert.ok(FONT_CAP_MS >= 6000, `cap ${FONT_CAP_MS}ms is under the 3.6s cold load plus margin`);
  assert.ok(FONT_CAP_MS <= 15000, `cap ${FONT_CAP_MS}ms could stall a 169-capture pass`);
});

test("the probe does not rely on document.fonts.check()", async () => {
  // The obvious simplification, and the one that must not come back.
  // `check()` reports whether the fonts *needed for the given text* are loaded,
  // and a family absent from the document's font list is needed by nothing — so
  // it returns true when the @import has not been applied at all. Gating on it
  // would photograph exactly the fallback face this module exists to refuse,
  // while reporting the page as ready.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./audit-fonts.mjs", import.meta.url), "utf8")
  );
  const inPage = source.slice(source.indexOf("function probeInPage"));
  assert.doesNotMatch(inPage, /fonts\s*\.\s*check\s*\(/);
  // And the two questions it does ask are both present.
  assert.match(inPage, /status/);
  assert.match(inPage, /getBoundingClientRect/);
});
