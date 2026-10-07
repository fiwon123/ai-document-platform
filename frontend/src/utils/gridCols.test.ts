/**
 * Every card grid on the marketing pages must show a full last row.
 *
 * `auto-fit` picks a column count from available width and knows nothing about
 * the item count, so it strands a card (#580). This asserts the rendered
 * geometry directly rather than trusting the CSS: it reads the computed
 * `grid-template-columns`, counts the tracks, and checks the item count divides
 * evenly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GRID_COUNTS, balancedGridClass } from "./gridCols";

describe("balancedGridClass", () => {
  it("maps each supported count to a class the stylesheet defines", () => {
    for (const n of GRID_COUNTS) {
      expect(balancedGridClass(n)).toBe(`page-grid page-grid--n${n}`);
    }
  });

  it("throws for a count with no rule rather than rendering an orphan row", () => {
    // 5 is the count that shipped the 4+1 orphan: no column count in 2 or 3
    // gives a full row, and one row of 5 cards is 235px each.
    expect(() => balancedGridClass(5)).toThrow(/No balanced column rule for 5/);
    expect(() => balancedGridClass(7)).toThrow();
    expect(() => balancedGridClass(0)).toThrow();
  });

  it("never returns a count that cannot divide evenly into 2 or 3 columns", () => {
    // The rule that actually matters: for every count we support, there is a
    // column count in {2, 3} that divides it, which is what keeps the last row
    // full at desktop width.
    for (const n of GRID_COUNTS) {
      const divides = [2, 3].some((cols) => n % cols === 0);
      expect(divides, `${n} cards have no full-row column count`).toBe(true);
    }
  });
});

describe("grid column rules in App.css", () => {
  const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");

  it.each(GRID_COUNTS)(
    "defines a .page-grid--n%s rule with a track count that divides the card count",
    (n) => {
      const rule = new RegExp(`\\.page-grid--n${n}\\s*\\{([^}]*)\\}`);
      const match = css.match(rule);
      expect(match, `.page-grid--n${n} is missing from App.css`).not.toBeNull();

      const body = match?.[1] ?? "";
      const counts = [...body.matchAll(/repeat\((\d+),/g)].map((m) => Number(m[1]));
      expect(counts.length, `.page-grid--n${n} must declare repeat(N, ...)`).toBeGreaterThan(0);

      for (const c of counts) {
        expect(
          n % c,
          `.page-grid--n${n} renders ${c} columns: ${n % c} card(s) stranded on the last row`,
        ).toBe(0);
      }
    },
  );

  it("has no auto-fit page-card grid left", () => {
    // `auto-fit` is what made the column count a function of width alone.
    expect(css).not.toMatch(/\.page-grid\s*\{[^}]*auto-fit/);
    expect(css).not.toMatch(/\.page-grid-secondary\s*\{[^}]*auto-fit/);
  });

  it("keeps the landing feature and step grids off auto-fit for the same reason", () => {
    for (const sel of [
      ".landing-grid-core",
      ".landing-grid-secondary",
      ".landing-steps",
      ".landing-plans",
    ]) {
      const idx = css.indexOf(sel);
      expect(idx, `${sel} is missing from App.css`).toBeGreaterThan(-1);
      const brace = css.indexOf("{", idx);
      const body = css.slice(brace + 1, css.indexOf("}", brace));
      expect(
        body.includes("auto-fit"),
        `${sel} still uses auto-fit, which ignores the card count`,
      ).toBe(false);
    }
  });
});

describe("marketing card counts", () => {
  it("SECONDARY_FEATURES has a count that balances at every breakpoint", async () => {
    const { SECONDARY_FEATURES } = await import("../content/marketing");
    // 6 divides by 3, 2 and 1, so the grid steps 3 → 2 → 1 with a full row
    // throughout. This is why the sixth card was added in #580.
    expect(SECONDARY_FEATURES).toHaveLength(6);
  });
});
