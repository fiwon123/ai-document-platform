import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Workspace navbar width-budget guard (#443).
 *
 * The app bar collapsed to a hamburger at <=768px, so between 769px and ~1279px it
 * tried to render `back + brand + links + user` on one line in a box that could not
 * hold it. Every workspace page had a horizontal scrollbar there — 480px wide at
 * 769px, 357px at 900px, 75px at 1200px — with `.navbar-user` as the culprit
 * (right edge 1257px in a 900px viewport).
 *
 * The overflow was *not* caused by a wrong `max-width`, which is why a style-lint or
 * a "no horizontal scroll" eyeball does not catch it. Three things combine:
 *
 *   - the content box is 88% of the viewport (`padding: 16px 6vw` takes 6vw a side),
 *     so a row needing N px of parts needs N / 0.88 px of viewport;
 *   - the row is built from four independent parts whose total is not written down
 *     anywhere, so nothing in the stylesheet knows the row has a budget;
 *   - the row is one flex line with `flex-wrap` only at the collapse width, so when
 *     the parts do not fit they push each other sideways rather than wrapping. The
 *     deficit is absorbed by the right gutter until it exceeds 6vw, then the document
 *     grows a scrollbar — a failure that is invisible at any single width.
 *
 * The two widths below are therefore arithmetic, not taste, and they are the real
 * invariants. Measured in Chromium, worst-case username (at its 160px cap):
 *
 *   trimmed row  = back 26 + brand 165 + links 512 + user 318 + 3 x 20 gap = 1047px
 *   complete row = back 118 + brand 205 + links 512 + user 318 + 3 x 20 =  1241px
 *
 * so the complete row first fits at 1241 / 0.88 = 1410px, and the trimmed row at
 * 1047 / 0.88 = 1189px. The stylesheet uses 1280px to collapse and 1439px to stop
 * trimming: both sit above their requirement, which is the whole point — a
 * breakpoint set *below* the width where the row fits is the bug, not the fix.
 *
 * The measured part widths are named constants so the arithmetic is auditable. What
 * must fail is a breakpoint dropping below its requirement, the two blocks crossing
 * or being duplicated, the username becoming unbounded (which would make the row's
 * width depend on a database value again), or the landing navbar's own 900px collapse
 * drifting while the workspace one is being edited.
 */

const rawCss = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `max-width: Npx` media block, in source order, comments already stripped. */
const maxWidthBlocks = (): { width: number; body: string }[] =>
  [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)].map((m) => ({
    width: Number.parseInt(m[1] ?? "0", 10),
    body: m[2] ?? "",
  }));

const ruleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

const declaration = (selector: string, name: string): string => {
  const m = ruleBody(selector).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared on ${selector}`);
  return m[1].trim();
};

/** Measured in Chromium, worst-case username. See the module comment. */
const TRIMMED_ROW_NEEDS = 1047;
const COMPLETE_ROW_NEEDS = 1241;

/**
 * The share of the viewport the navbar's content box occupies, derived from the
 * stylesheet's own padding so a change to `6vw` cannot leave this test asserting
 * against a stale fraction. The navbar uses the `padding` shorthand, so the
 * horizontal components are read positionally (2-value: [v, h]; 4-value: [t, r, b, l]).
 */
const contentFraction = (): number => {
  const shorthand = declaration(".navbar", "padding");
  const parts = shorthand.split(/\s+/);
  const horizontal = parts.length === 1 ? parts : parts.length <= 3 ? [parts[1]!] : [parts[1]!, parts[3]!];
  const vwValues = horizontal
    .map((v) => v.match(/^([\d.]+)vw$/)?.[1])
    .filter((v): v is string => v !== undefined);
  if (vwValues.length === 0) throw new Error(`.navbar padding has no vw component: ${shorthand}`);
  // The two sides are declared as one value; guard the symmetric case anyway.
  const perSide = vwValues.length === 1 ? Number.parseFloat(vwValues[0]!) : Math.max(...vwValues.map(Number.parseFloat));
  return 1 - 2 * (perSide / 100);
};

/** Viewport at which a row needing `needs` px actually fits. */
const viewportRequiredFor = (needs: number): number => Math.ceil(needs / contentFraction());

const blocksContaining = (needles: string[]): { width: number; body: string }[] => {
  const found = maxWidthBlocks().filter((b) => needles.every((n) => b.body.includes(n)));
  if (found.length === 0) throw new Error(`no max-width media block contains all of: ${needles.join(" , ")}`);
  return found;
};

describe("workspace navbar width budget (#443)", () => {
  it("collapses no earlier than the width the trimmed row actually fits", () => {
    const [collapse] = blocksContaining([".navbar-toggle", ".navbar-user"]);
    expect(collapse?.width).toBeGreaterThanOrEqual(viewportRequiredFor(TRIMMED_ROW_NEEDS));
  });

  it("stops trimming no earlier than the width the complete row actually fits", () => {
    const [trim] = blocksContaining([".navbar-workspace-badge", ".navbar-back-link-text"]);
    expect(trim?.width).toBeGreaterThanOrEqual(viewportRequiredFor(COMPLETE_ROW_NEEDS));
  });

  it("keeps the trimmed band between the two widths, and declares each band once", () => {
    const collapses = blocksContaining([".navbar-toggle", ".navbar-user"]);
    const trims = blocksContaining([".navbar-workspace-badge", ".navbar-back-link-text"]);

    // A second block with the same job means one of them is dead CSS and the
    // effective width is whichever the browser happens to apply last.
    expect(collapses).toHaveLength(1);
    expect(trims).toHaveLength(1);

    // The row is trimmed in the band (collapse, trim] and complete above it. If
    // these cross, some width either overflows or hides the pill and back label for
    // no reason.
    expect(trims[0]!.width).toBeGreaterThan(collapses[0]!.width);
  });

  it("bounds the username so the row's width never depends on a database value", () => {
    // `.navbar-username` is the only state-dependent part of the row. Without a cap
    // the widest state has to be re-measured per user; with one, the budget above is
    // a constant. An ellipsis without a max-width does nothing.
    expect(declaration(".navbar-username", "max-width")).toMatch(/\d+px$/);
  });

  it("hides the hamburger and the desktop user cluster by default", () => {
    // The collapse must be additive: if either were visible by default the desktop
    // row would show a toggle and a duplicate user cluster at every width.
    expect(declaration(".navbar-toggle", "display")).toBe("none");
    expect(declaration(".navbar-user-mobile", "display")).toBe("none");
  });

  it("leaves the landing navbar's 900px collapse alone", () => {
    // #424 budgeted the landing row so it stays on one line from 901px up, and its
    // width is set by a state-dependent CTA ("Sign up" 86.6px vs "Go to app"
    // 107.6px). It is a different navbar with a different budget; editing the
    // workspace one must not drag it along.
    // `display: none` on `.landing-nav-links` is the collapse's defining move —
    // the links leave the row entirely — and the 1200px compact band does not do
    // it. Keyed on that rather than on a selector, because `.landing-nav-links`
    // appears in both bands and the old `.nav-group-menu` probe went away with
    // the section menus.
    const landing = maxWidthBlocks().filter((b) =>
      /\.landing-nav-links\s*\{[^}]*display:\s*none/.test(b.body),
    );
    expect(landing).toHaveLength(1);
    expect(landing[0]!.width).toBe(900);
  });

  it("keeps the workspace row on a single flex line above the collapse width", () => {
    // `flex-wrap: wrap` only exists inside the collapse block, which is what turns
    // "overflows sideways" into "stays one row". If it were declared on the base
    // `.navbar` the row could wrap instead, changing the height budget silently.
    const base = ruleBody(".navbar");
    expect(base).not.toMatch(/flex-wrap/);
    const [collapse] = blocksContaining([".navbar-toggle", ".navbar-user"]);
    expect(collapse?.body).toMatch(/\.navbar\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
