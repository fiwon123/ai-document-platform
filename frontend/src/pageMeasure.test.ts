import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketing measure guard (#440).
 *
 * The 13 interior marketing routes rendered inside a 900px `.page-body`, which
 * is 46.9% of a 1920px viewport — the "pages are too small on a PC" report. The
 * workspace (`.main-content`) was already 1200px, so marketing was the narrow
 * thing on a large monitor.
 *
 * Widening the container is the easy half. The trap is the interaction with the
 * reading measure, and it is not obvious from the stylesheet:
 *
 *   - `.page-body` is `box-sizing: border-box`, so `max-width` is the WHOLE box
 *     and the `6vw` gutter is inside it. 900px meant 670px of content, not 900.
 *   - `ch` is the width of the "0" glyph, not of an average character. Measured
 *     in Manrope at 16px, 1ch = 10.0px while the average character in running
 *     prose is 7.37px, so **1ch ~= 1.36 real characters**. The intuitive
 *     "70 characters" expressed as `70ch` resolves to 700px ~= 94 characters,
 *     i.e. *wider* than the 670px it was supposed to protect.
 *
 * So the invariants pinned here are the relationships, not the literals. A
 * deliberate retune to 1240px, or 48ch, must not fail this file; what must fail
 * is marketing going narrower than the workspace again, the prose cap being
 * dropped or going wider than the container, and any later rule silently
 * re-declaring the measure.
 */

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const ruleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

/**
 * Like `ruleBody`, but for a selector that is the first item of a grouped list
 * (`.page-body ul,\n.page-body ol { ... }`). A grouped rule is invisible to a
 * helper that requires `{` straight after the selector, which would have made
 * the list cap look unset rather than wrong.
 */
const groupedRuleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*,\\s*[^{}]*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no grouped ${selector} block in the stylesheet`);
  return m[1];
};

/** Every declaration of `name` for `selector`, including inside media queries. */
const allDeclarationsFor = (selector: string, name: string): string[] =>
  [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g"))]
    .flatMap((m) => [...(m[1] ?? "").matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))])
    .map((m) => (m[1] ?? "").trim());

const declaration = (selector: string, name: string): string => {
  const m = ruleBody(selector).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared on ${selector}`);
  return m[1].trim();
};

const px = (value: string): number => {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`not a px value: ${value}`);
  return n;
};

const ch = (value: string): number => {
  const m = value.match(/^([\d.]+)ch$/);
  if (!m?.[1]) throw new Error(`not a ch value: ${value}`);
  return Number.parseFloat(m[1]);
};

/**
 * Measured in Chromium against Manrope 16px (see the module comment). Kept as a
 * named constant so the character budget in the assertions below is auditable
 * rather than a magic number.
 */
const CH_TO_CHARACTERS = 1.36;

const REAL_CHARACTERS_PER_CH = (value: string): number => ch(value) * CH_TO_CHARACTERS;

describe("marketing measure (#440)", () => {
  it("renders the marketing body at least as wide as the workspace", () => {
    const marketing = px(declaration(".page-body", "max-width"));
    const workspace = px(declaration(".main-content", "max-width"));

    // The bug was marketing at 900px under a 1200px workspace. Directional, so
    // an intentional change to either side is allowed; a regression is not.
    expect(marketing).toBeGreaterThanOrEqual(workspace);
  });

  it("declares the marketing measure exactly once, with no later override", () => {
    // A second `.page-body` rule is how a breakpoint or a later refactor would
    // quietly put the old narrow value back. Count declarations, not rules.
    expect(allDeclarationsFor(".page-body", "max-width")).toHaveLength(1);
  });

  it("caps prose far narrower than the container it sits in", () => {
    const container = px(declaration(".page-body", "max-width"));
    const prose = declaration(".page-body p", "max-width");

    // Prose must not simply follow the container: that is the readability
    // regression this file exists to prevent.
    expect(ch(prose)).toBeLessThan(ch(`${container / 10}ch`));
  });

  it("keeps the prose measure inside a readable 45-75 character budget", () => {
    const prose = declaration(".page-body p", "max-width");
    const characters = REAL_CHARACTERS_PER_CH(prose);

    // The number that actually matters. `70ch` fails this at ~95 characters,
    // which is the mistake this cap is most likely to be "corrected" back into.
    expect(characters).toBeGreaterThanOrEqual(45);
    expect(characters).toBeLessThanOrEqual(75);
  });

  it("declares the prose cap exactly once, and never wider than the container", () => {
    const declarations = allDeclarationsFor(".page-body p", "max-width");
    expect(declarations).toHaveLength(1);

    const container = px(declaration(".page-body", "max-width"));
    // 1ch is 10px in this font, so compare in the same unit.
    expect(ch(declarations[0] ?? "")).toBeLessThanOrEqual(container / 10);
  });

  it("caps lists on the same measure as paragraphs", () => {
    const paragraph = declaration(".page-body p", "max-width");
    // `.page-body ul, .page-body ol` is a grouped rule, hence groupedRuleBody.
    const list = groupedRuleBody(".page-body ul").match(/max-width\s*:\s*([^;]+);/)?.[1]?.trim();
    expect(list).toBe(paragraph);
  });

  it("caps the legal body on its container, so headings stay flush with their text", () => {
    // Capping the <p>s would leave every .legal-section h2 spanning the full
    // container while its own paragraph stopped short. Measured in Chromium:
    // both resolve to left 475px / width 520px, i.e. the same box.
    const legal = declaration(".legal-body", "max-width");
    const prose = declaration(".page-body p", "max-width");
    expect(legal).toBe(prose);
  });

  it("keeps the CTA band's own 54ch measure out of the prose rule's reach", () => {
    // `.page-body p` is (0,1,1) and an unscoped `.page-cta-band-sub` is
    // (0,1,0), so the prose cap silently wins on specificity. The band is
    // centred text, not a reading measure, and is scoped to opt out.
    expect(css).toMatch(/\.page-body \.page-cta-band-sub\s*\{/);
    const bandSub = declaration(".page-body .page-cta-band-sub", "max-width");
    expect(bandSub).toBe("54ch");
  });

  it("gives the hero a measure of its own that is not the paragraph measure", () => {
    // The hero headline is `clamp(..., 3.4rem)`; at 780px it was stranded in a
    // narrow column. Guard that it stays a real width rather than reverting.
    const hero = px(declaration(".page-hero-inner", "max-width"));
    expect(hero).toBeGreaterThanOrEqual(780);
  });
});
