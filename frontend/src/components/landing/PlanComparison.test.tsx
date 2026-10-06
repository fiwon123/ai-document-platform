/**
 * The ✓/✕ pair, and the table around them.
 *
 * #583 asked for a red ✕ "for what a plan does not include". The glyph was
 * `var(--muted)` at `opacity: 0.55` — grey, and faded, which is why an excluded
 * feature read as a cell someone forgot to fill in rather than as a deliberate
 * absence. The accessible labels were already correct, so this file guards the
 * colour (from the stylesheet) and the labels together, because a red ✕ with no
 * accessible name is the other half of the same bug.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlanComparison } from "./PlanComparison";

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block for a selector, comments stripped — the rules guarding
 * this carry long comments naming the properties they forbid, so an assertion
 * over raw text would be reading the comment. Same helper as
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

/** The bodies of every `@media <condition>` block, found by brace matching.

   A lazy `[\s\S]*?` cannot do this job: it will happily start at one media
   query's opening brace and scan on into a *different* block's body, which is
   how "the hint is revealed only at the narrow breakpoint" passed against a
   stylesheet where it was revealed at every breakpoint. Verified by
   re-introducing that defect and watching this fail.

   Every matching block is returned, because this file has several
   `(prefers-reduced-motion: reduce)` blocks. That is still safe: the callers'
   patterns are `\{[^}]*`-bounded, so a rule can only match within its own body,
   and only blocks carrying the condition asked about are in the string. */
function mediaBlocks(condition: string): string {
  const needle = `@media ${condition} {`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at < 0) break;
    let depth = 0;
    const open = css.indexOf("{", at);
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        bodies.push(css.slice(open, i));
        from = i;
        break;
      }
    }
  }
  return bodies.join("\n");
}

describe("PlanComparison glyphs", () => {
  it("labels an included feature and an excluded one", () => {
    const { container } = render(<PlanComparison />);
    // Both must be present as text, not as a bare glyph.
    expect(container.querySelector(".compare-check")).not.toBeNull();
    expect(container.querySelector(".compare-x")).not.toBeNull();
    expect(screen_text(container)).toContain("Included");
    expect(screen_text(container)).toContain("Not included");
  });

  it("hides the glyph from assistive tech so the label is not read twice", () => {
    const { container } = render(<PlanComparison />);
    const svgs = [...container.querySelectorAll(".compare-check, .compare-x")];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
    }
  });

  it("paints the ✕ red, and does not fade it", () => {
    // The regression: `color: var(--muted); opacity: 0.55` — not red at all, and
    // faded to roughly a third of whatever it was.
    const x = rule(".compare-x");
    expect(x).toMatch(/color:\s*var\(--compare-no\)/);
    expect(x).not.toMatch(/opacity/);
    expect(x).not.toMatch(/--muted/);
  });

  it("paints the ✓ with the green that survives the Pro column", () => {
    // `--green` is 3.30:1 on the table's white but 2.99:1 on the Pro column's
    // 7% blue tint — a fail of the 3:1 non-text bar by 0.01, invisible on
    // screen. `--green-text` (green-800 in light) measures 6.48:1 there.
    expect(rule(".compare-check")).toMatch(/color:\s*var\(--green-text\)/);
  });

  it("defines the ✕ per theme rather than reusing --danger", () => {
    // `--danger` is a *background* colour in this file and its dark-theme value
    // is a translucent tint, so reusing it here would break both uses.
    expect(rule(":root")).toMatch(/--compare-no:\s*#dc2626/);
    const dark = /\[data-theme="dark"\][^{]*\{[\s\S]*?--compare-no:\s*#f87171/.test(css);
    expect(dark, "no dark-theme --compare-no").toBe(true);
  });

  it("hardcodes no colour in the comparison markup", () => {
    // #581 established this rule for the architecture diagram: theme values
    // live in App.css, not in a component.
    const source = readFileSync(
      resolve(process.cwd(), "src", "components", "landing", "PlanComparison.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("PlanComparison scrolling and focus", () => {
  it("is reachable by keyboard so the overflow can be scrolled", () => {
    // At 375px the table is 442px wide in a 330px column. A scroll container
    // that cannot be scrolled from the keyboard is unusable without a mouse.
    const { container } = render(<PlanComparison />);
    const wrap = container.querySelector(".landing-table-wrap");
    expect(wrap?.getAttribute("tabindex")).toBe("0");
    expect(wrap?.getAttribute("role")).toBe("region");
    // A tab stop with no name is a mystery stop, so it needs a label.
    expect(wrap?.getAttribute("aria-label")).toBeTruthy();
  });

  it("highlights the row under the pointer and anything focused inside it", () => {
    expect(rule(".landing-table tbody tr:hover td")).toBeTruthy();
    expect(rule(".landing-table tbody tr:focus-within td")).toBeTruthy();
  });

  it("does not make every row a tab stop", () => {
    // 15 focusable rows would be a worse trap than no row highlight. The
    // scroll region above is the single tab stop, and it carries the ring.
    const source = readFileSync(
      resolve(process.cwd(), "src", "components", "landing", "PlanComparison.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/<tr[^>]*tabIndex/);
    expect(rule(".landing-table-wrap:focus-visible")).toMatch(/outline:\s*2px solid/);
  });

  it("pins the header only where the table actually scrolls", () => {
    // The table's minimum width is 442px, so it overflows only below ~520px
    // once the page's 6vw padding is added. Capping the wrapper's height
    // everywhere would put a nested scrollbar on a 1440px desktop for nothing.
    expect(rule(".landing-table thead th")).toMatch(/position:\s*sticky/);
    expect(rule(".landing-table thead th")).toMatch(/top:\s*0/);
    expect(
      mediaBlocks("(max-width: 520px)"),
      "the 70vh cap is not scoped to the narrow breakpoint",
    ).toMatch(/\.landing-table-wrap\s*\{[^}]*max-height:\s*70vh/);
    // And it must not be unconditional.
    expect(rule(".landing-table-wrap")).not.toMatch(/max-height/);
  });

  it("leaves the table itself unclipped, which is what made sticky inert", () => {
    // `overflow` on an element makes it a scroll container, so an
    // `overflow: hidden` on the table made the sticky `th` position against a
    // container that never scrolls: measured `stickyAfter: -304`.
    expect(rule(".landing-table")).not.toMatch(/overflow/);
    // The wrapper carries the same radius and does the clipping instead.
    expect(rule(".landing-table-wrap")).toMatch(/border-radius:\s*14px/);
    expect(rule(".landing-table-wrap")).toMatch(/position:\s*relative/);
  });

  it("gives the Pro column its tint on every row, not every other one", () => {
    // The zebra was `.landing-table tbody tr:nth-child(even) td` = (0,2,3) and
    // the Pro tint `.landing-table td.pro-cell` = (0,2,1), so on every even row
    // the zebra won and the highlighted column rendered as a dashed stripe with
    // a gap every other row. Excluding the Pro cell keeps both tints rather than
    // picking a winner by specificity.
    expect(rule(".landing-table tbody tr:nth-child(even) td:not(.pro-cell)")).toBeTruthy();
    expect(css).not.toMatch(/tr:nth-child\(even\) td \{/);
  });

  it("says the table scrolls on both axes, and says it outside the scroller", () => {
    // At 375px Enterprise is off-screen with nothing to indicate it, so the
    // table reads as broken rather than as scrollable.
    const { container } = render(<PlanComparison />);
    const hint = container.querySelector(".landing-table-hint");
    const text = hint?.textContent ?? "";
    expect(text).toMatch(/scroll/i);
    // Both axes, because the component's own 70vh cap hides 8 of the 15 rows on
    // a 375px screen and draws no scrollbar. A hint that only said "sideways"
    // pointed the reader at the one axis they *could* already see, and the
    // undiscoverable rows had no cue at all. Found by looking, not reasoning.
    expect(text).toMatch(/sideways/i);
    expect(text).toMatch(/\bdown\b/i);
    // Inside the scroller it would scroll away with the columns.
    expect(container.querySelector(".landing-table-wrap .landing-table-hint")).toBeNull();
    // It must not be a second description of a table the region already names.
    expect(hint).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the Pro band a band in dark, not a tint the zebra swallows", () => {
    // `:not(.pro-cell)` made the Pro *fill* continuous, but in dark a 7% blue
    // tint over the page is (23,35,54) and the zebra is (23,32,48) — a 1.03:1
    // luminance ratio. On every even row the column dissolved into its
    // neighbours and could only be found by its border lines, which is the
    // symptom the `:not()` was added to end. Measured from a capture, not
    // predicted: the fix is in the dark override, not the light 7%.
    expect(rule(':root[data-theme="dark"] .landing-table .pro-cell')).toMatch(
      /background:\s*color-mix\(in srgb, var\(--blue\) 1[0-9]%, transparent\)/,
    );
    // The light value stays where it was, so this is not a dark-only change
    // that quietly repaints the theme that already worked.
    expect(rule(".landing-table .pro-cell")).toMatch(/var\(--blue\) 7%/);
  });

  it("does not let the dark header rule erase the Pro header tint", () => {
    // `:root[data-theme="dark"] .landing-table thead th` is (0,3,2) and
    // `.landing-table th.pro-head` is (0,2,1), so in dark the band stopped at
    // the header — measured (43,58,85) on all three header cells, against a
    // tinted (203,216,239) in light. Same specificity trap as the zebra pair.
    expect(rule(':root[data-theme="dark"] .landing-table thead th')).not.toMatch(/:not\(/);
    expect(
      rule(':root[data-theme="dark"] .landing-table thead th.pro-head'),
      "the dark Pro header has no override of its own",
    ).toMatch(/background:/);
  });

  it("shows the scroll hint only where the table actually overflows", () => {
    // Same breakpoint as the `max-height` cap, and the same reason: the table's
    // minimum width is 442px, so it only overflows below ~520px. At 1440 the
    // hint would be a lie.
    expect(rule(".landing-table-hint")).toMatch(/display:\s*none/);
    expect(mediaBlocks("(max-width: 520px)"), "the hint is never revealed").toMatch(
      /\.landing-table-hint\s*\{[^}]*display:\s*block/,
    );
  });
});

/** The visually-hidden labels, which `textContent` includes and a bare
 * `querySelector` for the glyphs would miss. */
function screen_text(container: HTMLElement): string {
  return container.textContent ?? "";
}
