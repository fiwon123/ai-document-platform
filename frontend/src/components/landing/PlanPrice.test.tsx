/**
 * The price scale has to survive a specificity contest it lost once.
 *
 * `.landing-price` used to declare `font-size: 1.9rem` on itself. On
 * `/pricing` that declaration never applied, because `.page-body p` is
 * `(0,1,1)` and `.landing-price` is `(0,1,0)` — so the prose rule won on size
 * *and* on colour and the price rendered as 16px muted grey while the landing
 * page, which has no `.page-body` ancestor, rendered it correctly at 1.9rem ink.
 *
 * Measured: 16px/400 `rgb(95,111,133)` on `/pricing` against a `1.9rem`/800
 * intent. Nothing in the markup or the component changed to cause it, so a unit
 * test on the rendered tree would never have seen it. These tests therefore
 * assert the *cascade* from `App.css`, not just the DOM.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlanPrice } from "./PlanPrice";
import { splitPrice } from "../../utils/splitPrice";

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block for a selector, comments stripped. Stripping matters
 * here: the rules guarding this scale carry long comments that *name* the
 * properties being forbidden (`opacity`, `overflow: hidden`), so an assertion
 * that scanned the raw text would be testing the comment. Same helper shape as
 * `tintedContrast.test.ts`. */
function rule(selector: string): string {
  // The selector is escaped: `:nth-child(even)` and `:not(.pro-cell)` contain
  // regex metacharacters, and interpolated raw the parens became capture groups
  // and the rule silently did not match.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
}

/** Resolve a length to px. `rem` uses the 16px root. `clamp()` resolves to its
 * middle argument — what a viewport between the two bounds computes to. `em`
 * resolves against `parentPx`, which is how a relative step is checked. */
function px(declaration: string, parentPx?: number): number {
  const clamp = /clamp\([^,]+,\s*([\d.]+)px/.exec(declaration);
  if (clamp?.[1]) return Number(clamp[1]);
  const rem = /([\d.]+)rem/.exec(declaration);
  if (rem?.[1]) return Number(rem[1]) * 16;
  const raw = /([\d.]+)px/.exec(declaration);
  if (raw?.[1]) return Number(raw[1]);
  const em = /^([\d.]+)em$/.exec(declaration.trim());
  if (em?.[1] && parentPx !== undefined) return Number(em[1]) * parentPx;
  throw new Error(`cannot resolve a length from "${declaration}"`);
}

/** The resolved font size of a rule, in px. `parentPx` is needed only when the
 * declaration is relative (`em`). */
function fontSize(selector: string, parentPx?: number): number {
  const decl = /font-size:\s*([^;]+)/.exec(rule(selector));
  expect(decl?.[1], `no font-size on ${selector}`).toBeTruthy();
  return px(decl?.[1] ?? "", parentPx);
}

describe("splitPrice", () => {
  it("separates a currency mark from a figure", () => {
    expect(splitPrice("$12")).toEqual({ currency: "$", amount: "12" });
    expect(splitPrice("$0")).toEqual({ currency: "$", amount: "0" });
  });

  it("does not need a symbol table", () => {
    expect(splitPrice("€10")).toEqual({ currency: "€", amount: "10" });
    expect(splitPrice("£8")).toEqual({ currency: "£", amount: "8" });
  });

  it("leaves a word alone", () => {
    // This is the whole point: "Custom" must not have its first six
    // characters mistaken for a currency mark.
    expect(splitPrice("Custom")).toEqual({ currency: "", amount: "Custom" });
    expect(splitPrice("Free")).toEqual({ currency: "", amount: "Free" });
  });

  it("tolerates whitespace and thousands separators", () => {
    expect(splitPrice("  $1,200 ")).toEqual({ currency: "$", amount: "1,200" });
    expect(splitPrice("$12.50")).toEqual({ currency: "$", amount: "12.50" });
  });

  it("copes with a bare figure", () => {
    expect(splitPrice("12")).toEqual({ currency: "", amount: "12" });
  });

  it("keeps a leading minus with the currency", () => {
    // Not reachable from PLANS today. It is reachable from a future price edit,
    // and "-$5" must not lose its sign to the regex.
    expect(splitPrice("-$5")).toEqual({ currency: "-$", amount: "5" });
  });
});

describe("PlanPrice structure", () => {
  it("renders currency, amount and period as three elements", () => {
    const { container } = render(<PlanPrice price="$12" period="per month" />);
    expect(container.querySelector(".landing-price-currency")?.textContent).toBe("$");
    expect(container.querySelector(".landing-price-amount")?.textContent).toBe("12");
    // The period sits below the figure, not inside it: "/ per month" set after
    // "Custom" reads as part of the word.
    const figure = container.querySelector(".landing-price-figure");
    expect(container.querySelector(".landing-price-period")?.textContent).toBe("per month");
    expect(figure?.textContent).toBe("$12");
  });

  it("marks a word price so it can hold optical parity with a figure", () => {
    const { container } = render(<PlanPrice price="Custom" period="per team" />);
    const amount = container.querySelector(".landing-price-amount");
    expect(amount?.textContent).toBe("Custom");
    expect(amount?.className).toContain("landing-price-amount-word");
    // No currency element at all — an empty one would leave a gap.
    expect(container.querySelector(".landing-price-currency")).toBeNull();
  });

  it("does not mark a figure as a word", () => {
    const { container } = render(<PlanPrice price="$0" period="forever" />);
    expect(container.querySelector(".landing-price-amount")?.className).not.toContain(
      "landing-price-amount-word",
    );
  });

  it("renders the full price as text for copy and for tests that read the page", () => {
    const { container } = render(<PlanPrice price="$10" period="per month" />);
    expect(container.textContent).toBe("$10per month");
  });
});

describe("PlanPrice scale in the cascade", () => {
  it("puts no font-size on the <p>, where .page-body p could win it", () => {
    // The regression itself: `(0,1,0)` cannot beat `(0,1,1)`. Every size now
    // lives on a child span, which no `.page-body p` descendant rule reaches.
    expect(rule(".landing-price")).not.toMatch(/font-size/);
  });

  it("restates the price's own colour and margin against .page-body p", () => {
    // `.page-body p` also set `color: var(--muted)`, so the price was grey as
    // well as small. This rule is the only thing overriding it.
    expect(rule(".page-body .landing-price")).toMatch(/color:\s*var\(--ink\)/);
  });

  it("keeps the currency smaller than the figure", () => {
    const figure = fontSize(".landing-price-figure");
    const currency = fontSize(".landing-price-currency", figure);
    expect(currency).toBeLessThan(figure);
    // But not a different order of magnitude. A price whose dollar sign is
    // unreadable is its own defect: this caught `0.44em` resolving against the
    // inherited 16px (7.04px) instead of the amount.
    expect(currency / figure).toBeGreaterThan(0.3);
    expect(currency / figure).toBeLessThan(0.6);
  });

  it("resolves the currency's em against the figure, not the inherited size", () => {
    // The structural form is what guarantees the ratio above: the size is on
    // the figure and the amount inherits it at 1em.
    expect(rule(".landing-price-currency")).toMatch(/font-size:\s*[\d.]+em/);
    expect(rule(".landing-price-amount")).toMatch(/font-size:\s*1em/);
  });

  it("keeps the amount the largest thing in the block", () => {
    const figure = fontSize(".landing-price-figure");
    expect(fontSize(".landing-price-period")).toBeLessThan(figure);
    expect(fontSize(".landing-price-period")).toBeLessThan(16);
  });

  it("sets a word price at the figure's own size, not a step below it", () => {
    // #583: "Custom is set at the same optical size as a figure, not as loose
    // text". Two earlier revisions are what this rules out.
    //
    // Left at the figure's size, "Custom" is ~155px in a 264px card at 1440px
    // and ~125px in a 286px card at 375px, so it fits at every breakpoint and
    // the three prices are on one line by construction.
    //
    // Set one step down at 0.8em, the Enterprise card's price block was 8.8px
    // shorter than its neighbours' — the card is a column flex box sized by its
    // content, so its period, CTA and bottom border all rode 8-9px higher
    // (measured bottoms 784.4 vs 792.6; on `dev` all three were 814.2).
    //
    // Compensated with `line-height: calc(1.05 / var(--price-word-step))` to
    // restore the line box, which fixed the cards and left the glyph baselines
    // 4px apart: extra leading splits evenly above and below, so a taller
    // line-box does not move a smaller glyph's baseline. Three clevernesses
    // and still a misaligned row.
    expect(rule(".landing-price-amount-word")).toMatch(/font-size:\s*1em/);
    // No step variable left to drift out of step with itself.
    expect(rule(".landing-price-amount-word")).not.toMatch(/--price-word-step/);
    expect(rule(".landing-price-amount-word")).not.toMatch(/line-height/);
    // And it must not restate letter-spacing either: the digits do not, so a
    // word with different tracking is set on different metrics.
    expect(rule(".landing-price-amount-word")).not.toMatch(/letter-spacing/);
  });

  it("never breaks the price across lines", () => {
    // #583: prices must not reflow at 375px. "Custom" and "$12" are both
    // single tokens and both must survive a 330px card.
    expect(rule(".landing-price")).toMatch(/white-space:\s*nowrap/);
  });

  it("fades nothing that carries meaning", () => {
    expect(rule(".landing-price")).not.toMatch(/opacity/);
    expect(rule(".landing-price-period")).not.toMatch(/opacity/);
  });
});
