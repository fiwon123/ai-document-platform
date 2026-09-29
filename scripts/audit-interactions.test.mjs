/**
 * Unit tests for the scenario post-condition logic (#474).
 *
 * `applyInteraction` needs a real Playwright `page`, so it is not importable
 * for testing as written. The part that is easy to get subtly wrong — the
 * decision to *report* a scenario rather than photograph it — is extracted into
 * pure functions here and driven by a fake page, so the behaviour is testable
 * on a machine that has never run the audit.
 *
 * What these tests cannot cover is the reason the field exists: that the
 * captures are now byte-identical across runs. That is measured by hashing
 * three live runs, not asserted here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkClassExpectation,
  buildAttrWaitArgs,
  describeSkip,
  orderedStepKeys,
  unreachableStepKeys,
  undeclaredStepKeys,
  SCENARIO_METADATA_KEYS,
  STEP_OPTION_KEYS,
  STEP_ORDER,
} from "./audit-interactions.mjs";

// ── buildAttrWaitArgs ──────────────────────────────────────────────────────
// The argument object handed to page.waitForFunction. Serialised into the page,
// so it has to be plain data.

test("attr wait args carry selector, attribute and expected value", () => {
  const args = buildAttrWaitArgs('.billing-toggle [role="switch"]', "aria-checked", "true");
  assert.deepEqual(args, {
    sel: '.billing-toggle [role="switch"]',
    a: "aria-checked",
    v: "true",
  });
});

test("attr wait args keep falsy expected values as strings", () => {
  // An element with no such attribute yields null, never undefined, so a
  // boolean-ish expectation has to stay a string to be comparable at all.
  const args = buildAttrWaitArgs("#x", "aria-expanded", "false");
  assert.equal(args.v, "false");
  assert.equal(typeof args.v, "string");
});

// ── describeSkip ───────────────────────────────────────────────────────────
// The message shown to the user and stored in the manifest. A skip that does
// not say what was expected is nearly as bad as a silent wrong capture.

test("skip names the selector, the index and the class it wanted", () => {
  const msg = describeSkip("clickNth", { selector: ".carousel-dot", index: 1 }, "active");
  assert.match(msg, /\.carousel-dot/);
  assert.match(msg, /\[1\]/);
  assert.match(msg, /active/);
});

test("attr skip names the attribute, its expected value and the selector", () => {
  const msg = describeSkip(
    "assertAttr",
    { selector: '.billing-toggle [role="switch"]' },
    { attr: "aria-checked", value: "true" },
  );
  assert.match(msg, /aria-checked/);
  assert.match(msg, /"true"/);
  assert.match(msg, /role="switch"/);
});

test("a missing target skip says missing rather than did-not-take-effect", () => {
  // The two need different fixes — one a selector fix, the other a click that
  // did not land — so they must not collapse into one message.
  const msg = describeSkip("missing", { selector: ".carousel-dot", index: 1, action: "clickNth" });
  assert.match(msg, /clickNth target missing/);
});

// ── checkClassExpectation ───────────────────────────────────────────────────
// The post-condition on the carousel click. Whole class tokens only.

test("an active dot matches on its class token", () => {
  assert.equal(checkClassExpectation("carousel-dot active", "active"), true);
});

test("an inactive dot does not match active", () => {
  assert.equal(checkClassExpectation("carousel-dot", "active"), false);
});

test("the match is on whole tokens, not a substring", () => {
  // The failure this prevents: "inactive" contains "active", so a substring
  // check would call the *inactive* dot active and the post-condition would
  // pass on precisely the wrong element.
  assert.equal(checkClassExpectation("carousel-dot inactive", "active"), false);
  assert.equal(checkClassExpectation("carousel-dot inactive", "inactive"), true);
});

test("a class token is matched in any position", () => {
  assert.equal(checkClassExpectation("active carousel-dot", "active"), true);
});

test("a missing class attribute is a failure, not an empty match", () => {
  // An element with no class reads back as null. The caller wants to hear about
  // it, so this must not read as "no classes, nothing to check, fine".
  assert.equal(checkClassExpectation(null, "active"), false);
  assert.equal(checkClassExpectation(undefined, "active"), false);
});

test("surrounding and repeated whitespace does not invent tokens", () => {
  assert.equal(checkClassExpectation("  carousel-dot   active  ", "active"), true);
  assert.equal(checkClassExpectation("carousel-dot  ", "carousel-dot active"), false);
});

test("an unrecognised skip kind still names the selector and index", () => {
  // A new kind must not degrade to an empty or useless message.
  const msg = describeSkip("somethingNew", { selector: ".carousel-dot", index: 1 });
  assert.match(msg, /\.carousel-dot/);
  assert.match(msg, /\[1\]/);
  assert.match(msg, /somethingNew/);
});

// ── orderedStepKeys ─────────────────────────────────────────────────────────
// The order the audit *performs* its steps, which is what makes the carousel
// fix work: the hover stops the interval before the click, and the
// post-condition is checked after both.

test("only the steps a scenario asks for are run", () => {
  // A scenario with a click must not also get a hover: an unrequested
  // page.mouse.move would put the pointer somewhere the capture does not expect.
  const keys = orderedStepKeys({ click: ".x" });
  assert.deepEqual(keys, ["click", "settle"]);
});

test("settle runs for a scenario that asks for nothing at all", () => {
  // Every capture waits for the page to stop moving, including the ones with no
  // interaction to do. Forgetting it is invisible: the capture is just of a
  // transient frame.
  assert.deepEqual(orderedStepKeys({ state: "hero" }), ["settle"]);
});

test("settle is last, so it observes the page after every interaction", () => {
  const keys = orderedStepKeys({ click: ".x", hover: ".y", assertAttr: { selector: ".x", attr: "a", value: "b" } });
  assert.equal(keys[keys.length - 1], "settle");
});

test("hover is ordered before clickNth so a moving target can settle", () => {
  // The carousel fix depends on this: the hover stops the auto-advance, and a
  // clickNth that ran first would time out on the 30s actionability check.
  const keys = orderedStepKeys({ clickNth: { selector: ".carousel-dot", index: 1 }, hover: ".x" });
  assert.deepEqual(keys, ["hover", "clickNth", "settle"]);
});

test("scrollTo is ordered before click and clickNth, so the target is on screen", () => {
  // Declared out of order on purpose: `orderedStepKeys` sorts, so the order the
  // keys appear in the object must not matter.
  const keys = orderedStepKeys({ clickNth: { selector: ".a", index: 0 }, click: ".b", scrollTo: "bottom" });
  assert.deepEqual(keys, ["scrollTo", "click", "clickNth", "settle"]);
});

test("assertAttr is ordered last, since it checks an earlier interaction's effect", () => {
  const keys = orderedStepKeys({
    assertAttr: { selector: ".b", attr: "aria-checked", value: "true" },
    click: ".b",
    scrollTo: "selector:.b",
  });
  assert.deepEqual(keys, ["scrollTo", "click", "assertAttr", "settle"]);
});

test("fill and check run before anything that depends on the typed value", () => {
  const keys = orderedStepKeys({ click: ".submit", fill: { "#password": "x" }, check: "#remember" });
  assert.deepEqual(keys, ["fill", "check", "click", "settle"]);
});

test("a falsy step value is not treated as a request to run it", () => {
  // An empty string or a null must not add a step, or the audit would scroll
  // nowhere and record a scroll it never performed.
  assert.deepEqual(orderedStepKeys({ scrollTo: "", hover: null, click: ".x" }), ["click", "settle"]);
});

// ── unreachableStepKeys ─────────────────────────────────────────────────────
// The guard on the dispatch table staying in step with the order table.

test("no implemented step is reported unreachable", () => {
  assert.deepEqual(unreachableStepKeys(STEP_ORDER), []);
});

test("a step implemented but never orderable is reported by name", () => {
  // The inverse of the carousel bug: a step nobody can reach runs never, and
  // the capture is photographed as if it had.
  assert.deepEqual(unreachableStepKeys([...STEP_ORDER, "dragTo"]), ["dragTo"]);
});

// ── undeclaredStepKeys ──────────────────────────────────────────────────────
// The guard on a scenario asking for a step nothing implements. Found the hard
// way: two scenarios written with `run` produced four skips and a green run,
// because the video path honours `run` and the still path drops it silently.

test("a still declaring `run` is reported, not silently ignored", () => {
  // The regression this exists for. If this ever passes, the guard is gone and a
  // still can again be photographed as though an interaction happened.
  assert.deepEqual(undeclaredStepKeys({ route: "/x", state: "s", run: async () => {} }), ["run"]);
});

test("a scenario using only steps and metadata is clean", () => {
  assert.deepEqual(
    undeclaredStepKeys({
      route: "/app/search",
      state: "results",
      require: ".card",
      requireMs: 1000,
      note: "n",
      fill: { "#q": "revenue" },
      click: ".btn",
    }),
    [],
  );
});

test("an unknown interaction key is reported by name", () => {
  assert.deepEqual(undeclaredStepKeys({ route: "/x", state: "s", doubleClick: ".btn" }), ["doubleClick"]);
});

test("no metadata or option key collides with a step key", () => {
  // Otherwise a step could be added to STEP_ORDER and be silently exempted from
  // the guard by the metadata/option list, which would be a guard with a hole.
  const named = [...SCENARIO_METADATA_KEYS, ...STEP_OPTION_KEYS];
  assert.deepEqual(named.filter((key) => STEP_ORDER.includes(key)), []);
});

test("every listed key is actually used by some scenario shape", () => {
  // Not strictly necessary, but a stale entry in SCENARIO_METADATA_KEYS widens
  // the guard's blind spot: anything named there is exempt forever.
  const sample = {
    route: 1, state: 1, dir: 1, viewport: 1, theme: 1, auth: 1, expect: 1, require: 1,
    requireMs: 1, fullPage: 1, clipSelector: 1, probe: 1, throttledBefore: 1,
    note: 1, description: 1, interaction: 1, action: 1,
  };
  for (const key of SCENARIO_METADATA_KEYS) {
    assert.ok(key in sample, `${key} is listed as metadata but not accounted for in this test`);
  }
});

test("the two step options the audit reads are listed", () => {
  // `clickAgain` (a second click inside `click`) and `assertMs` (a timeout inside
  // `assertAttr`) are read off the scenario by the still path. If either is
  // renamed without being relisted, the guard would reject every scenario using
  // it — which is the point, but the rename should be deliberate.
  assert.deepEqual(STEP_OPTION_KEYS, ["clickAgain", "assertMs"]);
});

test("`run` is not a permitted still key, however it is spelled", () => {
  // Guards the guard: adding `run` to the metadata list to silence a failure
  // would restore the exact silent-drop this exists to prevent.
  const named = [...SCENARIO_METADATA_KEYS, ...STEP_OPTION_KEYS];
  assert.ok(!named.includes("run"), "`run` must stay reportable on a still");
});
