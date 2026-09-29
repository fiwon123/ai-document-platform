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
  planPageSteps,
  stepMoved,
  unreachableStepKeys,
  undeclaredStepKeys,
  MAX_PAGE_STEPS,
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
    requireMs: 1, assert: 1, assertMs: 1, fullPage: 1, clipSelector: 1, probe: 1, throttledBefore: 1,
    stepped: 1, stepOverlapPx: 1,
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

// ─────────────────────────────────────────────────────────────────────────────
// Stepped whole-page capture (#552)
// ─────────────────────────────────────────────────────────────────────────────

test("a page that fits the viewport is one step at the top, not zero steps", () => {
  // The regression this pins: `scrollHeight - viewportHeight` is 0 here, and a
  // naive plan returns an empty offset list — which photographs nothing while
  // still reporting the scenario as covered. Every mobile route is this shape.
  const plan = planPageSteps(812, 812);
  assert.equal(plan.steps, 1);
  assert.deepEqual(plan.offsets, [0]);
  assert.deepEqual(plan.states, ["top"]);
  assert.equal(plan.truncated, false);
});

test("a page shorter than the viewport is still one step", () => {
  const plan = planPageSteps(400, 812);
  assert.equal(plan.steps, 1);
  assert.deepEqual(plan.offsets, [0]);
});

test("offsets never exceed the scrollable distance", () => {
  // The last planned offset past the end of the page is the duplicate this
  // guards: the browser clamps it to the bottom, so it re-photographs the
  // previous step under a second name.
  const plan = planPageSteps(4000, 900);
  const scrollable = 4000 - 900;
  for (const offset of plan.offsets) {
    assert.ok(offset >= 0 && offset <= scrollable, `offset ${offset} outside 0..${scrollable}`);
  }
  assert.equal(plan.offsets.at(-1), scrollable, "the final step should reach the end of the page");
});

test("consecutive steps overlap by at least the requested amount", () => {
  // Zero overlap puts the cut wherever the arithmetic lands, so a heading split
  // across two images looks fine in both. This is what DEFAULT_STEP_OVERLAP_PX
  // is for.
  const plan = planPageSteps(6000, 900);
  for (let i = 1; i < plan.offsets.length; i += 1) {
    const gap = plan.offsets[i] - plan.offsets[i - 1];
    assert.ok(gap <= 900 - 120, `step ${i} advanced ${gap}px, leaving no overlap`);
    assert.ok(gap > 0, `step ${i} did not advance`);
  }
});

test("no two planned offsets are equal, whatever the page height", () => {
  // Probed across a range rather than one number: the clamp-and-dedupe path only
  // misfires for particular height/stride ratios, so a single case would pass
  // while the bug sat one line away.
  for (let height = 700; height <= 9000; height += 37) {
    for (const view of [812, 900]) {
      const plan = planPageSteps(height, view);
      const unique = new Set(plan.offsets);
      assert.equal(
        unique.size,
        plan.offsets.length,
        `duplicate offsets for ${height}px page in a ${view}px viewport: ${plan.offsets.join(",")}`,
      );
      assert.deepEqual(plan.states, [...new Set(plan.states)]);
    }
  }
});

test("a page too tall for the cap is truncated and says so", () => {
  // Silence here would be the worst outcome: the bottom of the page is not
  // covered, and the run reports every step it did take as a success.
  const plan = planPageSteps(400_000, 900);
  assert.equal(plan.truncated, true);
  assert.equal(plan.steps, MAX_PAGE_STEPS);
});

test("the cap is not applied to a page that needs fewer steps than the cap", () => {
  const plan = planPageSteps(3000, 900);
  assert.equal(plan.truncated, false);
  assert.ok(plan.steps < MAX_PAGE_STEPS);
});

test("states are `top` then `page-N`, and there is exactly one `top`", () => {
  const plan = planPageSteps(5000, 900);
  assert.equal(plan.states[0], "top");
  assert.deepEqual(plan.states.slice(1), plan.states.slice(1).map((_, i) => `page-${i + 2}`));
  assert.equal(plan.states.filter((s) => s === "top").length, 1);
  assert.equal(plan.states.length, plan.offsets.length);
});

test("a custom overlap changes the stride and therefore the step count", () => {
  // Otherwise `stepOverlapPx` would be accepted, stored, and never read — which is
  // the same silent-drop class as an unimplemented step key.
  //
  // The direction is worth stating because it looks wrong at a glance: MORE
  // overlap needs MORE steps, not fewer. Overlap is bought by shrinking the
  // stride — each capture re-photographs `stepOverlapPx` of the previous one —
  // so a higher value walks the same page in shorter hops. Tiling at 0 is the
  // cheapest and the least safe.
  const tiled = planPageSteps(5000, 900, { stepOverlapPx: 0 });
  const overlapped = planPageSteps(5000, 900, { stepOverlapPx: 400 });
  assert.equal(tiled.stride, 900);
  assert.equal(overlapped.stride, 900 - 400);
  assert.ok(
    overlapped.steps > tiled.steps,
    `overlap should cost extra captures, got ${overlapped.steps} vs ${tiled.steps}`,
  );
  // Both must still reach the bottom — the extra steps are repetition, not depth.
  for (const plan of [tiled, overlapped]) {
    assert.equal(plan.offsets.at(-1), 5000 - 900, "last step must reach the end of the page");
    assert.equal(plan.truncated, false);
  }
});

test("degenerate measurements cannot produce a zero step or a NaN offset", () => {
  // A page can report 0 height while it is still laying out; the planner is the
  // thing standing between that and a capture named `NaNpx`.
  for (const [h, v] of [[0, 900], [900, 0], [-100, 900], [900, -100], [NaN, 900], [4000, NaN]]) {
    const plan = planPageSteps(h, v);
    assert.ok(plan.steps >= 1, `no steps for ${h}/${v}`);
    for (const offset of plan.offsets) {
      assert.ok(Number.isFinite(offset) && offset >= 0, `bad offset ${offset} for ${h}/${v}`);
    }
  }
});

test("no step advances by less than half a stride, except the one that reaches the bottom", () => {
  // The measured waste this pins: /how-it-works at 1440×900 ends 81px past its
  // last stride, so finishing by *appending* produced a final frame 91% identical
  // to the one before it — a whole image to reveal the © footer line. The last
  // step must instead replace the previous one, so every frame advances a real
  // distance.
  //
  // The last step is exempt, and necessarily so. A page barely taller than the
  // viewport has only the remainder to cover — a 965px page in an 812px viewport
  // advances 153px, which is most of the viewport height and all that is left of
  // the page. Suppressing that frame would mean never photographing its bottom,
  // which is the original bug. The invariant that is actually safe to assert: no
  // step *before* the last is a near-duplicate.
  for (let height = 700; height <= 12000; height += 53) {
    for (const view of [812, 900]) {
      const plan = planPageSteps(height, view);
      for (let i = 1; i < plan.offsets.length - 1; i += 1) {
        const advance = plan.offsets[i] - plan.offsets[i - 1];
        assert.ok(
          advance >= plan.stride / 2,
          `${height}px page in a ${view}px viewport: step ${i} advanced only ${advance}px ` +
            `(stride ${plan.stride}) — a near-duplicate frame`,
        );
      }
      // And every frame except the last must land within a stride of the next,
      // so the two always overlap rather than leaving unphotographed content.
      for (let i = 0; i < plan.offsets.length - 1; i += 1) {
        const gap = plan.offsets[i + 1] - plan.offsets[i];
        assert.ok(
          gap <= view,
          `${height}px page in a ${view}px viewport: steps ${i}→${i + 1} advance ${gap}px, ` +
            "leaving unphotographed content between them",
        );
      }
    }
  }
});

test("the final step reaches the real bottom, unless it says it was cut short", () => {
  // The inverse of the test above, and the bug it replaced: never reaching the end
  // is worse than one redundant frame, because the bottom of the page is then
  // never photographed at all.
  //
  // The `truncated` escape is real and not a loophole — at 12 steps the cap stops
  // the walk on a very tall page (measured: 9127px in an 812px viewport ends at
  // 7612 of 8315). What must never happen is stopping short *without saying so*,
  // because that reports a partial page as a complete one.
  for (let height = 700; height <= 12000; height += 53) {
    for (const view of [812, 900]) {
      const plan = planPageSteps(height, view);
      const scrollable = Math.max(0, height - view);
      if (plan.truncated) {
        assert.ok(
          plan.offsets.at(-1) < scrollable,
          `${height}px page claims to be truncated but ends at the bottom`,
        );
        continue;
      }
      assert.equal(
        plan.offsets.at(-1),
        scrollable,
        `${height}px page in a ${view}px viewport ended at ${plan.offsets.at(-1)} of ${scrollable} ` +
          "without reporting truncation",
      );
    }
  }
});

test("reaching the bottom never exceeds the step cap", () => {
  // The cap and "always reach the end" are in tension by construction. When they
  // collide, the cap wins and `truncated` has to say so — silently truncating
  // would report a partial page as a complete one.
  const plan = planPageSteps(400_000, 900, { maxSteps: 5 });
  assert.ok(plan.steps <= 5);
  assert.equal(plan.truncated, true);
  assert.ok(plan.offsets.at(-1) < 400_000 - 900);
});

test("stepMoved accepts a one-pixel move and rejects a repeat", () => {
  // One pixel is still new content. Demanding exactness would report honest
  // captures as failures; accepting a repeat would restore the duplicate.
  assert.equal(stepMoved(0, 1), true);
  assert.equal(stepMoved(900, 1800), true);
  assert.equal(stepMoved(0, 0), false);
  assert.equal(stepMoved(1200, 1200), false);
});

test("a plan sized for a taller page still ends at the real bottom", () => {
  // The live bug this pins, measured on /contact at 1440×900 on 2026-09-29: the
  // page measured 2528px while planning and settled at 2438px once fonts and
  // images resolved, so the plan's final offset (2338) and the one before it
  // (2338 after clamping) landed on the same pixel. The run reported a SKIP — and
  // `skips` is a gate signal, so a correct walk failed the gate on the plan being
  // right for the page as first painted.
  //
  // The planner alone cannot fix this: it is handed a height, and the height it is
  // given is the wrong one. The repair is in `capturePageSteps`, which stops when
  // the page reports it is at the bottom rather than trusting the plan's length.
  // What is assertable here is that the plan is at least *reaching* the bottom it
  // was told about, so a regression in the arithmetic is still caught here.
  const planned = planPageSteps(2528, 900);
  assert.equal(planned.offsets.at(-1), 2528 - 900);

  // And the plan for the settled height must not end short of it either, which is
  // the other half: ending at 1538 of 1538, not at 780 of 1538.
  const settled = planPageSteps(2438, 900);
  assert.equal(settled.offsets.at(-1), 2438 - 900);
  assert.equal(settled.truncated, false);
});

// ── content assertions (#559) ────────────────────────────────────────────────
//
// The `qa/answer` scenario was green on a photograph of a provider error, twice,
// because `require` only asks "is this element attached". These pin the
// replacement: an assertion that checks the *substance* of a state.
//
// The assertion body itself runs in the page, so it cannot be imported here. It is
// re-implemented against a DOM-free stand-in, and the fixtures are the real
// strings from the capture that fooled the gate — a test that used invented
// strings would not have caught it.

/** The in-page ASSERT body, driven against a text fixture instead of a document. */
function applyAssertion(spec, text) {
  if (spec.matches && !spec.matches.every((n) => text.includes(n))) {
    return { ok: false, found: text.slice(0, 160) };
  }
  // `noneOf` first, matching the in-page ASSERT: an error is the more
  // informative reason to give and must not be reported as a word count.
  for (const n of spec.noneOf ?? []) {
    if (text.toLowerCase().includes(n.toLowerCase())) {
      return { ok: false, found: `contains forbidden text: ${n}` };
    }
  }
  if (spec.minLength != null && text.length < spec.minLength) {
    return { ok: false, found: `${text.length} chars, needed ${spec.minLength}` };
  }
  if (spec.minWords != null) {
    const words = text.split(" ").filter(Boolean).length;
    if (words < spec.minWords) return { ok: false, found: `${words} words, needed ${spec.minWords}` };
  }
  return { ok: true };
}

/** The spec the `qa/answer` scenario now carries. */
const QA_ANSWER_ASSERT = {
  label: "rendered answer, not an error",
  minWords: 12,
  // Mirrors the scenario's list, most specific first — the first match is the one
  // reported, so list order is part of the diagnostic.
  noneOf: [
    "could not generate",
    "ai service is not configured",
    "rate limit",
    "please try again",
  ],
};

// Verbatim from frontend/visual-audit/20260929-131231/app-qa/*-answer.png, which
// is the capture that was reviewed, found to be an error, and passed anyway.
const PROVIDER_ERROR =
  "Could not generate an answer with the AI provider. Please try again.";

test("a provider error does not satisfy the QA answer assertion", () => {
  // The whole point. This string was photographed and reported as a green
  // `answer` capture, with `skipped: 0`.
  assert.equal(applyAssertion(QA_ANSWER_ASSERT, PROVIDER_ERROR).ok, false);
});

test("a real answer satisfies the QA answer assertion", () => {
  const real =
    "Revenue grew across every region this quarter, led by APAC at 42%. " +
    "The ingestion pipeline processed 1,284 documents with a 99.2% success rate, " +
    "and search latency stayed under 200ms at p95.";
  assert.equal(applyAssertion(QA_ANSWER_ASSERT, real).ok, true);
});

test("an unconfigured provider is rejected, not treated as an answer", () => {
  assert.deepEqual(
    applyAssertion(QA_ANSWER_ASSERT, "AI service is not configured. Add an API key to ask questions."),
    { ok: false, found: "contains forbidden text: ai service is not configured" },
  );
});

test("a rate-limited answer is rejected", () => {
  // "rate limit" outranks the vaguer "please try again" in the list, so the skip
  // names the quota instead of a courtesy phrase.
  assert.deepEqual(
    applyAssertion(QA_ANSWER_ASSERT, "Rate limit reached for the provider. Please try again shortly."),
    { ok: false, found: "contains forbidden text: rate limit" },
  );
});

test("a short no-results message is rejected, and a short real answer with no error text is not", () => {
  // "Not in your documents" is a legitimate answer shape but too short to be a
  // real one; the floor exists so the state is not satisfied by a stub.
  assert.equal(applyAssertion(QA_ANSWER_ASSERT, "No relevant documents found.").ok, false);
  // ...while an answer that clears the floor and contains no failure string
  // passes, so the assertion is not merely a length proxy: the two must both hold.
  assert.deepEqual(
    applyAssertion(
      QA_ANSWER_ASSERT,
      "Revenue rose 12% this quarter to 4.1M, led by APAC at 42% growth.",
    ),
    { ok: true },
  );
});

test("the assertion is case-insensitive on forbidden text", () => {
  assert.deepEqual(
    applyAssertion(QA_ANSWER_ASSERT, "COULD NOT GENERATE an answer with the AI provider."),
    { ok: false, found: "contains forbidden text: could not generate" },
  );
});

test("an empty answer is rejected", () => {
  assert.equal(applyAssertion(QA_ANSWER_ASSERT, "").ok, false);
});
