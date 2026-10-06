import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reduced-motion guard for the decorative animations (#485).
 *
 * The visual audit photographs every still with `reducedMotion: "reduce"`, which
 * is what makes the landing captures reproducible: an infinite animation is
 * rasterised at a sub-pixel offset that depends on frame timing, so
 * `carousel-hover` and `desktop-light-hero` varied by up to 0.55% of pixels
 * between identical runs.
 *
 * That decision moves a real risk, so the risk is pinned here instead. With
 * stills captured under reduced motion, the audit can no longer see the animated
 * state at all — so if someone deletes a `@media (prefers-reduced-motion: reduce)`
 * block, every still stays identical and the diff stays green. The regression
 * would be invisible to the tool that exists to catch it.
 *
 * So the invariant is: the decorative animations the audit now relies on must
 * keep their reduced-motion opt-out. This is not a preference check. Motion is
 * exactly what a `prefers-reduced-motion` user asked not to see, and these
 * animations are infinite — the hero mesh drifts behind every marketing page
 * and never stops.
 *
 * Motion itself is still verified, just not by stills: `scripts/audit.mjs`
 * records a WebM per animated scenario and that context keeps motion enabled on
 * purpose.
 */

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The `@media (prefers-reduced-motion: reduce)` blocks, in source order. */
const reducedMotionBlocks: string[] = [
  ...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
]
  .map((m) => m[1] ?? "")
  .filter(Boolean);

const reducedMotionCss = reducedMotionBlocks.join("\n");

/**
 * Selector -> declarations across every reduced-motion block.
 *
 * A selector can be anywhere in a comma list — `.hero-mesh, .landing-cta-band {
 * animation: none }` covers the second one just as much as the first — so this
 * splits the lists rather than matching a selector and expecting a comma after
 * it. `reducedMotionBlocks` is one nesting level deep (simple rules inside the
 * media query), which is what `[^{}]+ { [^{}]* }` walks.
 */
const reducedMotionRules = (() => {
  const map = new Map<string, string>();
  for (const block of reducedMotionBlocks) {
    for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (m[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const selector of selectors) {
        map.set(selector, `${map.get(selector) ?? ""}${m[2] ?? ""}`);
      }
    }
  }
  return map;
})();

/**
 * Selectors whose animation must stop under reduced motion.
 *
 * `preview-float` and the hero-mesh drift are the two the audit's landing group
 * photographs. The rest are decorative movement on the public site; the carousel
 * and count-up also branch in JS on the same media feature, so their CSS rule
 * is the belt to that JS braces.
 */
const MUST_STOP = [".hero-mesh", ".landing-preview", ".landing-cta-band"];

describe("decorative animations honour prefers-reduced-motion", () => {
  it("finds the reduced-motion blocks at all", () => {
    // If the stylesheet is restructured and this stops matching, fail loudly
    // rather than reporting every selector as missing.
    expect(reducedMotionBlocks.length).toBeGreaterThan(0);
  });

  it.each(MUST_STOP)("%s stops animating under reduced motion", (selector) => {
    expect(
      reducedMotionRules.get(selector) ?? "",
      `${selector} has no \`animation: none\` inside a ` +
        `\`prefers-reduced-motion: reduce\` block. The audit photographs every ` +
        `still with reducedMotion: "reduce", so a missing opt-out here makes ` +
        `that page non-deterministic again *and* leaves motion running for ` +
        `users who asked for it to stop — with no diff to catch either.`,
    ).toMatch(/animation:\s*none/);
  });

  it("does not disable transitions or content that reduced-motion users still need", () => {
    // A blunt `* { animation: none !important }` would satisfy every check
    // above while also killing the reveal-on-scroll content and the carousel
    // transition, which is not the same thing as respecting the preference.
    expect(reducedMotionCss).not.toMatch(/\*\s*\{[^}]*animation:\s*none/);
  });
});
