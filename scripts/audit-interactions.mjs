/**
 * Pure decision logic for the audit's scenario post-conditions (#474).
 *
 * Two capture scenarios were non-deterministic: the landing carousel
 * auto-advances on a JS interval, so the slide under the shutter depended on
 * elapsed wall-clock time, and the billing toggle's click occasionally landed
 * before React attached its handler, so the "annual" capture sometimes
 * photographed the monthly table. Three runs of identical code produced three
 * different images, which makes every pixel comparison downstream meaningless.
 *
 * `audit.mjs` applies the checks; the decisions live here so they can be tested
 * without Playwright. The judgement each one encodes:
 *
 * - A scenario whose post-condition did not hold is **reported, not
 *   photographed.** A missing capture is visible; a plausible wrong one is
 *   not, and pixel diffing would report the wrong image as a real regression.
 * - A class match is on whole class tokens, never a substring. The inactive
 *   dot's class is "carousel-dot" and the active one's is "carousel-dot active",
 *   so a substring check would call an inactive dot active and pin nothing.
 */

/** Split a class attribute into whole tokens, tolerating a null attribute. */
function classTokens(cls) {
  if (typeof cls !== "string") return [];
  return cls.trim().split(/\s+/).filter(Boolean);
}

/**
 * Does an element's class list contain `expected` as a whole class?
 *
 * An element with no class attribute reads back as `null`, which is a failure
 * rather than an empty match — the caller wants to hear about it.
 */
export function checkClassExpectation(cls, expected) {
  return classTokens(cls).includes(expected);
}

/**
 * Argument object for the `page.waitForFunction` that waits on an attribute.
 *
 * It is serialised into the page context, so it must be plain data. The
 * comparison happens in the browser, which is why the expected value stays a
 * string: an element missing the attribute yields `null`, so `"false"` and
 * `null` have to remain distinguishable.
 */
export function buildAttrWaitArgs(selector, attr, value) {
  return { sel: selector, a: attr, v: value };
}

/**
 * Human-readable reason for a skipped capture, stored in the manifest.
 *
 * Says what was expected, not just that something went wrong: a skip nobody can
 * act on will be ignored, which puts the audit back to silently missing
 * captures.
 */
export function describeSkip(kind, target, expectation) {
  const where =
    target.index === undefined
      ? target.selector
      : `${target.selector} [${target.index}]`;

  if (kind === "missing") return `${target.action} target missing: ${where}`;

  if (kind === "unstable") {
    // Distinct from "missing" on purpose: one needs a layout-settling fix, the
    // other a selector fix, so they must not collapse into one message.
    return `${target.action} target never stopped moving: ${where}`;
  }

  if (kind === "assertAttr") {
    return `post-condition not met: ${expectation.attr}="${expectation.value}" on ${where}`;
  }

  if (kind === "clickNth") {
    return `${target.action} did not take effect: ${where} has no .${expectation}`;
  }

  return `${kind} failed: ${where}`;
}

/**
 * The order `applyInteraction` runs its steps in — the order the audit
 * *performs*, read by `orderedStepKeys`, not a comment describing it.
 *
 * The ordering is the fix, not an implementation detail:
 *
 * - `fill`/`check` first, because a later step may click submit.
 * - `scrollTo` before anything that needs the target on screen.
 * - `hover` before `clickNth`, because the hover is what stops the carousel's
 *   auto-advance; a click first would time out on the actionability check.
 * - `assertAttr` before `settle`, because a post-condition is about the
 *   interaction having taken effect, and settling is about the page having
 *   stopped moving; the second cannot sensibly precede the first.
 * - `settle` last, because it waits for the page to stop moving and so must
 *   observe the page *after* every interaction that could move it.
 *
 * It is a list rather than an ordered table of weights on purpose. A weight
 * table is a second source of truth that nothing would need to read, and the
 * `.sort()` that consumed it was a no-op that no test could have caught. The
 * tests below pin the relative orders above, so reordering this list fails
 * loudly instead of silently reordering every capture.
 */
export const STEP_ORDER = [
  "fill",
  "check",
  "scrollTo",
  "click",
  "hover",
  "clickNth",
  "assertAttr",
  "settle",
];

/**
 * Steps every scenario runs, whatever it asks for.
 *
 * `settle` is one: waiting for the page to stop moving is not something a
 * scenario should be able to forget, because forgetting it is invisible — the
 * capture is simply of a transient frame, and the next run photographs a
 * different one. Making it opt-in would put that risk in every scenario
 * definition instead of in one list.
 */
export const ALWAYS_ON = ["settle"];

/**
 * The steps a scenario actually asks for, in the order they must run.
 *
 * Pure, so the ordering is testable without a browser — it is the reason the
 * carousel fix works, and a reordering regression would otherwise only show up
 * as a slow, intermittently failing capture.
 *
 * Steps the scenario does not request are dropped rather than run: `hover` is
 * absent from most scenarios, and running a no-op would be harmless except that
 * it would put a `page.mouse.move` where a capture expects an untouched pointer.
 */
export function orderedStepKeys(scenario) {
  return STEP_ORDER.filter((key) => ALWAYS_ON.includes(key) || scenario[key]);
}
/**
 * Steps `applyInteraction` implements but `orderedStepKeys` can never return.
 *
 * A step wired up in one place and forgotten in the other never runs, and the
 * capture is then photographed as though it had — the same class of plausible
 * but wrong image this module exists to prevent. The inverse mistake (a key in
 * `STEP_ORDER` with no implementation) already throws, because the dispatch is a
 * lookup.
 */
export function unreachableStepKeys(implemented) {
  return implemented.filter((key) => !STEP_ORDER.includes(key));
}

/**
 * Scenario keys that describe the scenario rather than an interaction to perform.
 *
 * Everything else a scenario may declare has to name a step that `applyInteraction`
 * actually implements. `route`, `state` and `require` are consumed by the capture
 * itself; the rest are documentation or capture options.
 */
export const SCENARIO_METADATA_KEYS = [
  // What to capture
  "route",
  "state",
  "dir",
  "viewport",
  "theme",
  "auth",
  "expect",
  "require",
  "requireMs",
  "fullPage",
  "clipSelector",
  "probe",
  "throttledBefore",
  // Stepped whole-page capture (#552)
  "stepped",
  "stepOverlapPx",
  // Documentation, carried into the manifest
  "note",
  "description",
  "interaction",
  "action",
];

/**
 * Options *of* a step rather than steps in their own right.
 *
 * `clickAgain` is a second click inside the `click` step and `assertMs` is a
 * timeout inside the `assertAttr` step, so neither is orderable and neither needs
 * an implementation of its own. They still have to be named here: they are read
 * off the scenario, and a key that is read but unlisted is exactly the silent
 * no-op `undeclaredStepKeys` exists to catch.
 */
export const STEP_OPTION_KEYS = ["clickAgain", "assertMs"];

/**
 * Steps a scenario asks for that no step implements, so they can never run.
 *
 * The mirror of `unreachableStepKeys`, and the mistake this module most needs to
 * catch: a scenario declaring `run: async (page) => …` on a still is *silently*
 * dropped, because the video path honours `run` and the still path does not. The
 * capture is then photographed as though the interaction had happened — the
 * plausible-but-wrong image that is the reason any of this exists. It was found
 * the hard way: two scenarios written with `run` produced four skips and a green
 * run, because nothing said the interaction had been dropped.
 *
 * `run` is deliberately **not** in `SCENARIO_METADATA_KEYS`. The video path
 * consumes it, which makes it look like metadata, but honouring it on a still
 * would mean the guard has to know which path it is on. Instead it is reported
 * here, and the message says what to do instead.
 */
export function undeclaredStepKeys(scenario) {
  const allowed = new Set([...STEP_ORDER, ...STEP_OPTION_KEYS, ...SCENARIO_METADATA_KEYS]);
  return Object.keys(scenario).filter((key) => !allowed.has(key));
}

/**
 * Default overlap between consecutive stepped captures.
 *
 * Not zero. A step boundary lands wherever the arithmetic lands, and a section
 * that starts 40px above the cut is then split across two images with the seam
 * invisible in either — which is how a broken heading gets read as fine twice.
 * 120px of overlap puts the seam inside the previous step's last screenful, so
 * whatever is near it appears whole in at least one image. It costs ~10% more
 * pixels than tiling and is the difference between "reviewable" and "technically
 * covered".
 */
export const DEFAULT_STEP_OVERLAP_PX = 120;

/** Never plan more steps than this, whatever the page height claims. */
export const MAX_PAGE_STEPS = 12;

/**
 * Plan the scroll positions for a stepped whole-page capture (#552).
 *
 * The marketing routes photograph a single viewport-height image named `top`,
 * which is 900px of a page that runs several thousand — so the audit reports
 * `horizontalOverflow: []` and zero findings for content it never rendered. The
 * reviewers of the 2026-09-29 run independently said the same thing three times:
 * they could not check below-the-fold content, and `how-it-works` stages 2–6 were
 * never in any image.
 *
 * `fullPage: true` is the obvious alternative and is still wrong here:
 * `page.screenshot({ fullPage })` does **not** scroll — it resizes the capture
 * surface — so reveals below the fold can still be at `opacity: 0` when the
 * buffer is taken, which is precisely the failure the extra coverage is meant to
 * catch. It also produces one image 5–6× the height of a viewport, which every
 * viewer then downscales until the detail is gone.
 *
 * So: walk the page in viewport-sized steps and capture each one. Every step is a
 * real scroll, so every reveal gets the scroll it was waiting for, and each image
 * is one screenful a human can actually read.
 *
 * Returns the **scroll offsets** (not the derived states), so the caller decides
 * what to name and photograph. Pure, because the arithmetic is the part worth
 * testing and it is the part a browser would otherwise be needed to check.
 *
 * @param {number} scrollHeight  document height in px
 * @param {number} viewportHeight  `window.innerHeight` in px
 * @param {{ stepOverlapPx?: number, maxSteps?: number }} [options]
 * @returns {{ offsets: number[], states: string[], totalHeight: number, viewportHeight: number, stride: number, steps: number, truncated: boolean }}
 */
export function planPageSteps(scrollHeight, viewportHeight, options = {}) {
  const {
    stepOverlapPx = DEFAULT_STEP_OVERLAP_PX,
    maxSteps = MAX_PAGE_STEPS,
  } = options;

  const height = Math.max(0, Math.floor(scrollHeight) || 0);
  const view = Math.max(1, Math.floor(viewportHeight) || 0);

  // A page that fits in the viewport has exactly one step, and it is the top.
  // Rounding here rather than trusting `scrollHeight - viewportHeight`, because
  // a document 900px tall with a 900px viewport has zero scrollable distance and
  // one screenful — not zero captures.
  const scrollable = height <= view ? 0 : height - view;
  const stride = Math.max(1, view - stepOverlapPx);

  const offsets = [];
  if (scrollable <= 0) {
    offsets.push(0);
  } else {
    for (let i = 0; i < maxSteps; i += 1) {
      const raw = i * stride;
      if (raw >= scrollable) break;
      offsets.push(raw);
    }
    const last = offsets.at(-1);
    // Reach the end of the page, without paying for a near-duplicate frame to do
    // it.
    //
    // Two ways to finish, and which applies is not a matter of taste — appending
    // when the remainder is tiny buys a frame that is 91% identical to the one
    // before it (measured: /how-it-works ends 81px past its last stride, so the
    // appended frame was a whole image to reveal the © footer line).
    //
    // But *replacing* is not the safe default, and this is the bug it caused when
    // it was: moving the last step forward by more than the overlap leaves the
    // tail of the old step uncovered. Advance the last offset 1200px on a 900px
    // viewport and the region between the two frames is simply never photographed
    // — a gap, which is worse than a duplicate because it is invisible.
    //
    // So replacement is only legal when the remainder fits inside the overlap that
    // was already going to be re-shot: then advancing the last frame by `remainder`
    // keeps the previous frame's advance at `stride + remainder <= viewport`, so
    // the two still overlap and nothing is skipped. Anything larger is appended,
    // where the advance is the remainder itself and therefore always overlaps.
    //
    // Never reaching the end was the bug before all of this — a 4000px page in a
    // 900px viewport stopped at 2340px of 3100 and reported four clean steps with
    // the footer never photographed, which is the gap #552 was filed for,
    // reproduced inside the fix.
    if (last !== undefined && scrollable - last > 1) {
      const remainder = scrollable - last;
      if (remainder <= stepOverlapPx) {
        offsets[offsets.length - 1] = scrollable;
      } else if (offsets.length < maxSteps) {
        offsets.push(scrollable);
      }
    }
  }

  const unique = [...new Set(offsets)];

  // A page that is still taller than the plan covers, by arithmetic or by the cap.
  const truncated = scrollable > 0 && unique.at(-1) < scrollable;

  const states = unique.map((offset, i) => (offset === 0 ? "top" : `page-${i + 1}`));

  return {
    offsets: unique,
    states,
    totalHeight: height,
    viewportHeight: view,
    stride,
    steps: unique.length,
    truncated,
  };
}

/**
 * Has this stepped capture actually moved the page?
 *
 * The runtime half of the duplicate check `planPageSteps` makes statically. A
 * page can grow between measuring and scrolling (a late font swap, an image
 * without dimensions), so the plan can be stale by the time it runs — and a stale
 * plan photographs the same screenful twice under two names, which reads in review
 * as thorough coverage while covering nothing new.
 *
 * Compared at 1px rather than exactly: a scroll that lands one pixel off is still
 * new content, and demanding exactness would report honest captures as failures.
 */
export function stepMoved(previousOffset, offset) {
  return Math.abs(offset - previousOffset) >= 1;
}
