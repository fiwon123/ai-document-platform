import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reflow guard for the public marketing pages (WCAG 2.1 SC 1.4.10).
 *
 * SC 1.4.10 requires content to be presentable at 320px without
 * two-dimensional scrolling. Two separate rules used to break it, and both
 * failed *silently* — the offending box was clipped on screen, so the page
 * looked fine and the failure only showed up as draggable empty space to the
 * right of the content:
 *
 *  1. `.landing-table-wrap` scrolls a 442px table inside a 330px box, but the
 *     page still gained 39px of scroll range at 375px. The visually-hidden
 *     `.sr-only` spans in the table cells are `position: absolute`, and a
 *     scroll container only clips an absolutely positioned descendant when it
 *     is that descendant's containing block. Nothing was positioned, so they
 *     escaped the wrapper and stretched the document.
 *  2. `.footer-cols` used a bare `1fr` at <=820px. A grid track's automatic
 *     minimum is its content's min-content size, and the brand column's is
 *     ~327px (the newsletter input's intrinsic width plus a Subscribe button
 *     that cannot wrap) against ~281px of available space, so the track grew
 *     and pushed the page 26px wide.
 *
 * jsdom performs no layout: every `scrollWidth` and `clientWidth` is 0, so
 * asserting `scrollWidth === clientWidth` here would pass vacuously and guard
 * nothing. These assertions therefore pin the *mechanism* — the two
 * declarations that produce the invariant — and the invariant itself is
 * verified in a real browser. That evidence is recorded in PR #433:
 * `scrollWidth === clientWidth` on /, /pricing, /features, /how-it-works,
 * /security, /contact and /gdpr at 320, 360, 375, 390, 414, 430 and 480px,
 * while the table stays 442px wide and its wrapper stays internally
 * scrollable, and at >=640px the only difference in the whole page is the
 * `position` keyword on the wrapper.
 */
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Declarations of a rule, or of every rule a selector matches across the file. */
const rulesFor = (selector: string): string[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) =>
      (m[1] ?? "")
        .split(",")
        .some((s) => s.trim().replace(/\s+/g, " ").toLowerCase() === selector.toLowerCase()),
    )
    .map((m) => m[2] ?? "");

describe("marketing reflow", () => {
  it("positions the table's scroll wrapper so its absolute children stay clipped", () => {
    const rules = rulesFor(".landing-table-wrap");
    expect(rules.length, "no .landing-table-wrap rule in App.css").toBeGreaterThan(0);

    // The rule is inside a max-width media query, which is why every match is
    // checked rather than the first.
    const positioned = rules.filter((r) => /position\s*:\s*relative/.test(r));
    expect(
      positioned.length,
      ".landing-table-wrap must be position: relative — without it the absolutely " +
        "positioned .sr-only spans in the table cells escape overflow-x: auto and " +
        "give the document ~39px of horizontal scroll at 375px",
    ).toBe(rules.length);

    // The scroll affordance has to survive: the table is wider than a phone.
    for (const rule of rules) {
      expect(rule).toMatch(/overflow-x\s*:\s*auto/);
    }
  });

  it("lets the narrow footer column shrink below its content's min-content width", () => {
    // Only the <=820px block collapses to one column, so a bare 1fr there is
    // what let the newsletter form's ~327px min-content widen the page.
    const narrow = css.match(
      /@media[^{]*max-width:\s*820px[^{]*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(narrow, "no @media (max-width: 820px) block in App.css").toBeDefined();

    const footer = narrow!.match(/\.footer-cols\s*\{([^}]*)\}/)?.[1];
    expect(footer, "no .footer-cols rule in the max-width: 820px block").toBeDefined();
    expect(
      footer,
      "the narrow .footer-cols must be minmax(0, 1fr): a bare 1fr takes its " +
        "automatic minimum from the content, and the brand column's min-content " +
        "is ~327px against ~281px of space, pushing the page 26px wide at 320px",
    ).toMatch(/grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
    expect(footer).not.toMatch(/grid-template-columns\s*:\s*1fr\s*;/);

    // The input has to be the thing that gives way, not the page: a flex item's
    // automatic minimum size is its content width.
    const input = rulesFor(".newsletter-form input")[0] ?? "";
    expect(input, ".newsletter-form input must keep min-width: 0").toMatch(
      /min-width\s*:\s*0/,
    );
  });

  it("does not let the newsletter placeholder fall back to the browser gray", () => {
    // Convention is "Style ::placeholder with var(--muted)" (App.css header,
    // rule 6), and the muted token passes WCAG AA on the input surface in
    // both themes. The newsletter input had no ::placeholder rule at all, so
    // it rendered the UA default #757575 — 4.21:1 light, 3.30:1 dark, both
    // under the 4.5:1 threshold. #757575 is a value no theme token owns, so
    // any theme-independent gray would fail on one of them; the token cannot.
    const placeholder = rulesFor(".newsletter-form input::placeholder");
    expect(
      placeholder.length,
      ".newsletter-form input::placeholder must be covered — without it the " +
        "input renders the UA default gray, below WCAG AA in both themes " +
        "(measured in a real browser: 4.68:1 light / 5.92:1 dark after the fix)",
    ).toBeGreaterThan(0);
    for (const rule of placeholder) {
      expect(rule).toMatch(/color\s*:\s*var\(\s*--muted\s*\)/);
      expect(rule).toMatch(/opacity\s*:\s*1\s*;/);
    }
  });

  it("stacks the newsletter form on narrow phones so the placeholder is not clipped", () => {
    // The input's content box is the width that must hold the placeholder
    // (~137px of text at 14.4px Manrope, measured against
    // `you@company.com`). The single-row form cannot deliver it below ~410px —
    // at 375px the input is squeezed to a 113px content box and the placeholder
    // rendered as `you@company.c`, and at 320px even a full-width row is short
    // because the Subscribe button cannot wrap. The row has to become a column,
    // where the input alone takes the whole form width (#573).
    const narrow = css.match(
      /@media[^{]*max-width:\s*430px[^{]*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(narrow, "no @media (max-width: 430px) block in App.css").toBeDefined();

    const form = narrow!.match(/\.newsletter-form\s*\{([^}]*)\}/)?.[1];
    expect(form, "no .newsletter-form rule in the max-width: 430px block").toBeDefined();
    expect(form, "the narrow form must stack: a row cannot fit the placeholder").toMatch(
      /flex-direction\s*:\s*column/,
    );
    expect(form, "the stacked form must take the whole column the row only took 80% of").toMatch(
      /width\s*:\s*100%/,
    );

    // The single-row form must survive above the breakpoint: the base rule is
    // the one that carries `.btn-primary` next to the input at >=431px.
    const base = rulesFor(".newsletter-form")[0] ?? "";
    expect(base, "the base .newsletter-form rule must stay a row").toMatch(/width\s*:\s*80%/);
  });
});
