/**
 * Know that a capture is in the real typeface before photographing it (#537).
 *
 * `settleVisuals()` already awaits `document.fonts.ready`, and a capture still
 * came out in a fallback face — measured by the visual agent at 6× zoom: the
 * H1 "Settings" 103px wide in that capture against 120px in the one taken
 * seconds later, the nav item "Dashboard" 69px against 74px, different `g` tail
 * and `S`/`t` terminals. Every signal the audit records for that capture said
 * it was fine (`pageErrors: 0`, `consoleErrors: 0`, `overflowPx: 0`), which is
 * why nobody caught it and why it needs a gate rather than a longer sleep.
 *
 * ## Why `document.fonts.ready` is not enough
 *
 * The page loads its typefaces with a CSS `@import` of the Google Fonts
 * stylesheet, and that import is itself a network fetch. The sequence is:
 *
 *   1. HTML + local CSS arrive, the page paints in the fallback face
 *   2. the `@import` fetches the *stylesheet* (a second round trip)
 *   3. the stylesheet's `src:` URLs fetch the *font files* (a third)
 *
 * `document.fonts.ready` resolves when the font loads *currently pending* have
 * settled. At step 1 there are none pending — the faces are not even registered
 * yet — so it resolves immediately and the capture is taken in the fallback.
 * That is the race, and it is why the fix is not "wait a bit longer": a longer
 * sleep narrows the window without closing it.
 *
 * ## Why not `document.fonts.check()`
 *
 * It is the obvious call and it does not work. Per spec, `check()` reports
 * whether the fonts *needed to render the given text* are loaded, and a family
 * that is not in the document's font list is not needed by anything — so with
 * the stylesheet not yet applied, `check('600 16px "Manrope"')` returns **true**
 * precisely when nothing is loaded. It cannot distinguish "the face is ready"
 * from "there is no face to have been ready", which is the only distinction
 * that matters here. The probe below therefore asks the two questions that
 * cannot both be true of a fallback: is a face registered *and* loaded, and does
 * the text actually render at a different width than the fallback?
 *
 * ## The two questions
 *
 * - **Registered and loaded**: a face for the family exists in
 *   `document.fonts` *and at least one of them is loaded*. Cheap, and it catches
 *   the stylesheet having not arrived at all. The "at least one" is not a
 *   detail: the Google Fonts stylesheet registers ~25 unicode-range subset
 *   faces per family, so a family that is rendering perfectly well has two
 *   dozen faces stuck at `unloaded` — they are simply not needed for the text
 *   on the page. Reading the first face and asking whether *it* is loaded
 *   therefore reports a correctly rendered page as not ready, and skips every
 *   capture. Measured on the live sandbox: 26 Manrope faces, one loaded.
 * - **Actually applied**: a hidden probe string is measured with the web family
 *   and with a fallback the web family cannot be, and the two widths must
 *   differ. This is the ground truth — it measures the render, not the
 *   bookkeeping — and it is what would catch a face that is loaded but not
 *   being used (a `unicode-range` miss, a `font-display` swap that never
 *   repaints, a variable-font instance that fails to parse).
 *
 * Both must hold. Either alone has a failure mode, and the tests cover them.
 */

/**
 * The families the app's own CSS declares (`frontend/src/App.css` line 1
 * imports Manrope and DM Mono; `index.css` maps both `--sans` and `--heading`
 * to Manrope).
 *
 * DM Mono is only used for code, but both arrive in the same `@import`, so
 * requiring both is one fact about the network rather than two guesses about
 * which page uses what. A page that never renders a monospace run still has the
 * face loaded, and asking about it costs nothing.
 */
export const REQUIRED_FAMILIES = ["Manrope", "DM Mono"];

/**
 * How long to wait for the faces before reporting a capture as skipped.
 *
 * 8s, against a measured cold load of 3.0–3.6s in the dev container (two round
 * trips: the `@import` stylesheet, then the font files). The first value tried
 * was 3s, which is under the real cold time — so the gate would have skipped
 * the first capture of a cold run, which is the same failure as refusing every
 * capture, just harder to see.
 *
 * The cost of a generous cap is only paid by captures that are being skipped
 * anyway: the wait ends the moment the faces are applied, so a healthy page
 * pays milliseconds. The upper bound matters more than the lower one — 169
 * captures in a full pass, so a cap measured in minutes would turn one broken
 * page into a broken run.
 */
export const FONT_CAP_MS = 8000;

/** Gap between observations while waiting. */
export const FONT_POLL_MS = 100;

/**
 * Measure a family, in the page.
 *
 * Serialized into the browser, so it must be self-contained: no closure over
 * anything from this module. Returns plain data — the decision is made out here
 * by `classifyFontState`, where it can be tested without a browser.
 *
 * The probe string is deliberately mixed-case with digits and two wide
 * glyphs: a string whose width is identical in two faces is one the faces agree
 * on, and that would make the comparison say "not applied" about a font that is
 * applied. The fallback is `monospace` because neither web family is
 * monospaced, so a face being applied can never coincidentally match it.
 */
function probeInPage(required) {
  // `Face.family` may be quoted (`"Manrope"`) depending on the browser, and
  // the stylesheet may declare the family with or without quotes. Compare on
  // the bare name.
  const bare = (value) => String(value).replace(/["']/g, "").trim();
  // Every status registered for the family, not just the first face: a webfont
  // served as unicode-range subsets is one family and many faces, and only the
  // one matching the page's text is ever loaded. The reduction to loaded /
  // loading / absent is `classifyFontState`'s, because that is a decision and
  // decisions are what this module's tests pin.
  const faces = {};
  for (const family of required) {
    const statuses = [...document.fonts]
      .filter((f) => bare(f.family) === family)
      .map((f) => f.status);
    faces[family] = statuses.length ? statuses : null;
  }

  const measure = (stack) => {
    const el = document.createElement("span");
    el.textContent = "Handgloves 0123 WQ";
    el.style.cssText = [
      "position:absolute",
      "left:-9999px",
      "top:0",
      "white-space:nowrap",
      "font-size:64px",
      "font-weight:600",
      `font-family:${stack}`,
    ].join(";");
    document.body.appendChild(el);
    const width = el.getBoundingClientRect().width;
    el.remove();
    return Math.round(width * 100) / 100;
  };

  const widths = {};
  for (const family of required) {
    widths[family] = {
      web: measure(`"${family}", monospace`),
      fallback: measure("monospace"),
    };
  }
  return { faces, widths, documentFontStatus: document.fonts.status };
}

/**
 * Decide whether a page is in its real typeface, from one observation.
 *
 * Pure and total: a missing, malformed or partial observation is treated as
 * "not ready" rather than throwing, because every caller wants the same answer
 * to a question it must ask again.
 *
 * The per-face statuses are reduced here rather than in the page, because the
 * reduction is a decision: a family counts as loaded when *any* of its faces
 * is, which is the case that unicode-range subsets make routine and which a
 * first-face read gets wrong.
 */
export function classifyFontState(observation, { required = REQUIRED_FAMILIES } = {}) {
  const faces = observation?.faces ?? {};
  const widths = observation?.widths ?? {};
  const notReady = [];

  for (const family of required) {
    const registered = faces[family];
    const loaded = Array.isArray(registered) && registered.includes("loaded");
    // `null` means the family was never registered (the stylesheet has not
    // arrived); a non-empty list of statuses with none loaded means it has
    // arrived and is still fetching. Those are different problems and the
    // message has to tell them apart.
    const status = loaded ? "loaded" : registered ? "loading" : "absent";
    const measured = widths[family];
    const applied =
      measured &&
      Number.isFinite(measured.web) &&
      Number.isFinite(measured.fallback) &&
      measured.web !== measured.fallback;

    if (!loaded || !applied) {
      notReady.push({ family, status, applied: Boolean(applied) });
    }
  }

  return {
    ready: notReady.length === 0,
    // `status` is carried into the message because the two failure modes need
    // different responses: "absent" means the stylesheet never arrived (the
    // sandbox is offline, or the CDN is blocked), "loading" means it is late and
    // worth waiting for.
    missing: notReady.map((m) => `${m.family} (${m.status})`),
    reason: notReady.length
      ? `fonts not ready: ${notReady.map((m) => `${m.family} (${m.status})`).join(", ")}`
      : null,
  };
}

/**
 * Wait until the page is in its real typeface, or report why it is not.
 *
 * Never throws: a capture gate that cannot decide must not take the run down,
 * and a font problem is a *skip with a reason*, not a crash. The caller decides
 * what to do with `{ ready: false }` — `shot()` skips rather than photographs.
 *
 * `evaluate` and `waitForTimeout` are injectable so the polling loop is
 * testable without a browser; the defaults are the Playwright page's.
 */
export async function waitForFonts(
  page,
  {
    required = REQUIRED_FAMILIES,
    capMs = FONT_CAP_MS,
    pollMs = FONT_POLL_MS,
    evaluate,
    waitForTimeout,
    now = () => Date.now(),
  } = {}
) {
  const run = evaluate ?? ((fn, arg) => page.evaluate(fn, arg));
  const sleep = waitForTimeout ?? ((ms) => page.waitForTimeout(ms));
  const started = now();

  // Drain what is *already* pending first, so the first observation is made
  // against a settled FontFaceSet rather than racing the fetches we can see.
  // This does not replace the wait below — at this point the `@import`'s faces
  // are usually not registered yet, which is the whole problem.
  try {
    await run(() => document.fonts.ready);
  } catch {
    // A navigation mid-wait throws here. The observation below will report it
    // as not ready, which is the honest answer.
  }

  for (;;) {
    let observation = null;
    try {
      observation = await run(probeInPage, required);
    } catch {
      observation = null;
    }
    const verdict = classifyFontState(observation, { required });
    const waitedMs = now() - started;
    if (verdict.ready || waitedMs >= capMs) {
      return { ...verdict, waitedMs, capped: !verdict.ready };
    }
    await sleep(pollMs);
  }
}
