/**
 * The landing card grids must stay equal-height within a row.
 *
 * The secondary grid used to wrap each card in a `Reveal`, whose inline-flex
 * box collapsed the card back to its own content height — so a row's cards had
 * different heights and the bottom edge stepped down by the difference (24px
 * measured). The reveal is applied to the card itself now, so the card stays a
 * grid item that stretches with its row.
 *
 * These assert the structural cause, since equal rendered height needs a layout
 * engine: no box element between a `.landing-grid` and its `.landing-card`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_FEATURES, SECONDARY_FEATURES } from "./marketing";

const landing = readFileSync(resolve(process.cwd(), "src", "pages", "LandingPage.tsx"), "utf8");
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");

/** The source of the grid that opens the first `className` containing `marker`,
 * from that opening tag to its matching `</div>`, by brace counting. */
function gridSource(marker: string): string {
  const idx = landing.indexOf(marker);
  expect(idx, `${marker} is missing from LandingPage.tsx`).toBeGreaterThan(-1);

  const start = landing.lastIndexOf("<div", idx);
  let depth = 0;
  for (let i = start; i < landing.length; i += 1) {
    if (landing.startsWith("<div", i)) depth += 1;
    else if (landing.startsWith("</div>", i)) {
      depth -= 1;
      if (depth === 0) return landing.slice(start, i + 6);
    }
  }
  throw new Error(`unbalanced <div> for ${marker}`);
}

describe("landing card rows", () => {
  it.each([
    ["landing-grid-core", CORE_FEATURES],
    ["landing-grid-secondary", SECONDARY_FEATURES],
  ])("%s renders each card as a direct grid child", (marker, features) => {
    const block = gridSource(marker);
    expect(features.length).toBeGreaterThan(0);

    // The card is a direct grid child — no wrapper box, which is what made the
    // row's cards different heights in the first place. `RevealCard` renders the
    // <article> itself, so it standing alone here is the whole point.
    expect(block).not.toMatch(/<Reveal[^>]*>\s*<RevealCard/);
    expect(block).toMatch(/<RevealCard[\s\S]*?className="[^"]*landing-card/);
    // RevealCard applies the reveal itself; it is not a hand-written class.
    expect(block).not.toMatch(/className="[^"]*reveal-card/);
    // No other element sits between the grid and its cards.
    const between = block
      .replace(/<RevealCard[\s\S]*?<\/RevealCard>/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\s*\w[\w.]*\.map\([\s\S]*?\n\s*\)\}\}/g, "")
      .replace(/\{[\s\S]*?\}/g, "");
    expect(between.replace(/<\/?div[^>]*>/g, "")).not.toMatch(/<\w/);
  });

  it("keeps a card count that balances at every breakpoint", () => {
    // Six divides by 3, 2 and 1, so the grid steps 3 → 2 → 1 with a full row
    // throughout. That is why #580 added a sixth secondary card. Three core
    // cards step 3 → 1, skipping 2 for the same reason.
    expect(SECONDARY_FEATURES).toHaveLength(6);
    expect(CORE_FEATURES).toHaveLength(3);
  });
});

describe("reveal-card", () => {
  /** The body of the first rule whose selector list contains `selector`. */
  function ruleBody(selector: string): string {
    const re = new RegExp(`([^{}]*\\${selector}[^{}]*)\\{([^}]*)\\}`);
    const m = css.match(re);
    expect(m, `${selector} has no rule in App.css`).not.toBeNull();
    return m?.[2] ?? "";
  }

  it("starts hidden and resolves to visible, like .reveal", () => {
    expect(ruleBody(".reveal-card")).toMatch(/opacity:\s*0/);
    expect(ruleBody(".reveal-card")).toMatch(/translateY\(14px\)/);
    expect(ruleBody(".reveal-card.is-revealed")).toMatch(/opacity:\s*1/);
  });

  it("is visible under prefers-reduced-motion — content is never stranded hidden", () => {
    // Scan every reduced-motion block rather than the first: an unrelated one
    // (theme transitions) appears long before this rule.
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)];
    const withCard = blocks.filter((b) => /reveal-card/.test(css.slice(b.index, b.index + 400)));
    expect(withCard, "reveal-card has no prefers-reduced-motion override").not.toHaveLength(0);

    const body = ruleBody(".reveal-card");
    expect(body).toMatch(/opacity:\s*0/);
    // The override itself must resolve to visible.
    const m = css.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.reveal-card\s*\{([^}]*)\}/,
    );
    expect(m, "no reduced-motion block sets .reveal-card").not.toBeNull();
    expect(m![1]).toMatch(/opacity:\s*1/);
  });

  it("does not promote a long-lived card to its own compositor layer", () => {
    // The wrapper variant needs will-change; a card that stays on the page for
    // the whole session does not, and the layer costs memory.
    expect(ruleBody(".reveal-card")).not.toMatch(/will-change/);
  });
});
