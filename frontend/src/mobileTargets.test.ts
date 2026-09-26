import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Touch targets, and the two clipped-value bugs that hid behind them (#442).
 *
 * Every standalone target on the marketing and auth pages measured **23.2px**
 * tall — the height of a text line box, one under WCAG 2.5.8's 24x24 floor. That
 * is 276 instances across the 25 routes: the brand, the five header links, the
 * 14 footer links, the auth back link, "Forgot password?" (123x19, the shortest
 * target in the app), the "Remember me" label, and the workspace brand. Nothing
 * catches this in review — a link that *looks* the right size is a link that is
 * one pixel under the floor.
 *
 * Two traps make the naive fix wrong, and both are asserted below:
 *
 *   1. **A label is not the control.** The "Remember me" checkbox is a 15x15
 *      `input`, but 2.5.8 measures the *target*, and for a checkbox the wrapping
 *      label is it — the label was 125x23.2, so the label is what has to grow.
 *      Conversely the floating "Username"/"Password" labels are 23.2px too, but
 *      they are *not* the target: the input they label is 239x44. Growing those
 *      would have been busywork. Same for prose links, which 2.5.8 exempts
 *      outright ("in a sentence or block of text") — padding them breaks the text
 *      flow for no accessibility gain.
 *
 *   2. **The mobile 44px targets must not reach the desktop row.** 2.5.5 (and
 *      every mobile platform) wants 44px from a thumb, and that is a different
 *      question from 2.5.8's 24px. #424 budgeted the landing navbar to stay on
 *      exactly one row, 80.2px at 901/1024px and 82.2px at 1280px+, and #443 did
 *      the same for the workspace navbar's 1280px collapse. Handing the desktop
 *      row a 44px target would grow it. So the 44px values live *only* inside each
 *      navbar's own collapse band (<=900px marketing, <=1280px workspace) and the
 *      base rules keep the 24px floor — asserted as the negative case below.
 *
 * The two clipping bugs are here because they are the same class of defect (a box
 * that cannot hold its content) and the same reason they survived: a value that
 * is silently cut off rather than one that visibly overflows.
 *
 *   - The auth card lost 20px at 320px. `.social-buttons` is a two-column grid,
 *     so it sets a 204px min-content floor (Google 98 + GitHub 96 + a 10px gap)
 *     against a 184px content box. As a grid item `.auth-card` has
 *     `min-width: auto`, so the floor grew the card to 292px and
 *     `.auth-shell`'s `overflow: hidden` ate the difference. A document-level
 *     "is there a horizontal scrollbar" check sees nothing.
 *   - "September 2026" was ellipsised to "September…" from 320px to ~700px wide,
 *     because the three-across stat grid left a 36-67px content box for a 157px
 *     monospace value.
 *
 * The first one is arithmetic and is recomputed from the stylesheet below, so the
 * 360px breakpoint cannot drift below the width where the two-column layout
 * actually stops fitting.
 */

const rawCss = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** WCAG 2.5.8 (AA) — the floor every standalone target must clear at every width. */
const AA = 24;
/** WCAG 2.5.5 (AAA) / mobile platform guidance — thumb-sized, collapse bands only. */
const MOBILE = 44;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mediaBlocks = (feature: "max-width" | "min-width") =>
  [...css.matchAll(new RegExp(`@media\\s*\\(${feature}:\\s*(\\d+)px\\)\\s*\\{([\\s\\S]*?)\\n\\}`, "g"))].map(
    (m) => ({ width: Number.parseInt(m[1] ?? "0", 10), body: m[2] ?? "" }),
  );

const ruleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

const declaration = (selector: string, name: string): string => {
  const m = ruleBody(selector).match(new RegExp(`${escapeRe(name)}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared on ${selector}`);
  return m[1].trim();
};

const blockContaining = (feature: "max-width" | "min-width", needles: string[]) => {
  const found = mediaBlocks(feature).filter((b) => needles.every((n) => b.body.includes(n)));
  if (found.length === 0) {
    throw new Error(`no ${feature} media block contains all of: ${needles.join(" , ")}`);
  }
  return found;
};

const px = (value: string): number => {
  const n = value.match(/^([\d.]+)px$/)?.[1];
  if (n === undefined) throw new Error(`expected a px length, got "${value}"`);
  return Number.parseFloat(n);
};

/** Min-content of the two social buttons side by side, measured in Chromium. */
const SOCIAL_TWO_COL_FLOOR = 204;
/** Min-content of "September 2026" at 700 1.15rem DM Mono, measured in Chromium. */
const PROFILE_DATE_WIDTH = 157;

describe("touch targets (#442)", () => {
  it("declares the 24px floor on every target that measured 23.2px", () => {
    // Each of these was measured at 23.2px tall, or 19px for the forgot link.
    const floorTargets = [
      ".landing-brand",
      ".landing-nav-links a",
      "nav.footer-col a",
      ".auth-back",
      ".remember-row",
      ".forgot-link",
      ".navbar-brand a",
    ];
    for (const selector of floorTargets) {
      expect(declaration(selector, "min-height"), selector).toBe(`${AA}px`);
    }
  });

  it("keeps the footer nav rule matching the nav columns it was written for", () => {
    // The column IS the `<nav>` (`<nav className="footer-col">`), so the descendant
    // form `.footer-col nav a` matches zero elements. That silently disabled the
    // whole rule: the 14 nav links rendered as unstyled browser-default blue
    // underlined anchors, 23.2px tall. Qualifying the `nav` itself also keeps the
    // `.footer-social` circle in the brand column out of its reach.
    expect(css).not.toMatch(/\.footer-col\s+nav\s+a/);
    expect(css).toMatch(/nav\.footer-col\s+a\s*\{/);
  });

  it("leaves the 44px targets out of the desktop navbar", () => {
    // The negative case for #424 and #443: the base rules are what the desktop
    // row is built from, so 44px here would grow a row that was budgeted to
    // 80.2/82.2px. The floor is 24px and nothing more.
    for (const selector of [".landing-brand", ".landing-nav-links a", ".navbar-brand a"]) {
      expect(declaration(selector, "min-height"), selector).toBe(`${AA}px`);
      expect(px(declaration(selector, "min-height")), selector).toBeLessThan(MOBILE);
    }
  });

  it("gives the marketing header 44px targets only inside its 900px collapse", () => {
    // 34x34 theme toggle, 31.2px disclosure trigger, and a 43.2px primary CTA
    // (0.8px under). The nav links themselves get the full 44px here, where this
    // row *is* the primary navigation.
    const [collapse] = blockContaining("max-width", [".nav-group-trigger", ".landing-nav-actions .theme-toggle"]);
    expect(collapse?.width).toBe(900);
    for (const needle of [".nav-group-trigger", ".landing-nav-actions .btn", ".landing-nav-links a", ".landing-brand"]) {
      // `[,\\{]` because `.landing-nav-links a,` and `.landing-brand` share one rule.
      expect(collapse?.body, needle).toMatch(
        new RegExp(`${escapeRe(needle)}\\s*[,\\{][^}]*min-height:\\s*${MOBILE}px`),
      );
    }
  });

  it("gives the workspace navbar 44px targets only inside its 1280px collapse", () => {
    const [collapse] = blockContaining("max-width", [".navbar-back-link", ".navbar-brand a"]);
    expect(collapse?.width).toBe(1280);
    // Above 1439px the back link shows its label; below that it is icon-only and
    // `padding: 6px` collapses it to 26x26, so the collapsed band is where it
    // needs the thumb-sized box.
    expect(collapse?.body).toMatch(/\.navbar-back-link\s*\{[^}]*min-height:\s*44px/);
  });

  it("sizes the hamburger 44x44, and only where it is actually shown", () => {
    // 40x40 was under. The 44px is safe on the base rule precisely because the
    // hamburger is `display: none` above 1280px — that pairing is the whole
    // reason the size can live outside a media block, so assert both halves.
    expect(px(declaration(".navbar-toggle", "width"))).toBe(MOBILE);
    expect(px(declaration(".navbar-toggle", "height"))).toBe(MOBILE);
    expect(declaration(".navbar-toggle", "display")).toBe("none");
    expect(blockContaining("max-width", [".navbar-toggle", ".navbar-user"])[0]?.width).toBe(1280);
  });
});

describe("values that were clipped instead of overflowing (#442)", () => {
  it("cannot clip the auth card at 320px, by arithmetic", () => {
    // Recompute the width the two-column layout needs from the paddings actually
    // declared in the stylesheet, so changing either padding cannot leave this
    // asserting against a stale number.
    const pagePadding = px(declaration(".auth-page", "padding"));
    const cardPadding = px(declaration(".auth-card", "padding"));
    const contentBoxAt320 = 320 - 2 * pagePadding - 2 * cardPadding;
    expect(contentBoxAt320).toBe(184);

    // 204px of buttons in a 184px box: the card grows, the shell clips.
    expect(SOCIAL_TWO_COL_FLOOR).toBeGreaterThan(contentBoxAt320);
    const twoColNeeds = SOCIAL_TWO_COL_FLOOR + 2 * cardPadding + 2 * pagePadding;
    expect(twoColNeeds).toBe(340);

    // So the single-column block must cover every width up to and including the
    // one where the two-column layout stops fitting. Setting it at 339 would pass
    // today's measurement and re-break the moment a label grows a pixel: at 340px
    // the two-column layout has exactly 0px of headroom.
    const [stack] = blockContaining("max-width", [".social-buttons"]);
    expect(stack?.width).toBeGreaterThanOrEqual(twoColNeeds);
    expect(stack?.body).toMatch(/\.social-buttons\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("stacks the social buttons instead of widening the card", () => {
    // The other way to stop the clip is to shave the card's padding, which hides
    // the cause instead of removing the 204px floor. Stacking keeps the 44px
    // padding the form is designed around.
    const stacked = blockContaining("max-width", [".social-buttons"])[0]?.body ?? "";
    expect(stacked).not.toMatch(/padding/);
  });

  it("lets the profile stat value wrap rather than ellipsise it", () => {
    // "September 2026" was clipped to "September…" from 320px to ~700px wide. The
    // tiles are the one place a long value is expected, so nothing is hidden: a
    // `nowrap` + `ellipsis` + `overflow: hidden` trio here is the bug.
    const body = ruleBody(".profile-stat-value");
    expect(body).not.toMatch(/white-space\s*:\s*nowrap/);
    expect(body).not.toMatch(/text-overflow/);
    expect(body).not.toMatch(/overflow\s*:\s*hidden/);
    // A declared `overflow-wrap: normal` wraps nothing, so the value matters, not
    // just the presence of the property.
    const wrap = body.match(/overflow-wrap\s*:\s*([^;]+);/)?.[1]?.trim();
    expect(["break-word", "anywhere"]).toContain(wrap);
  });

  it("keeps the profile tiles single-across where the widest value cannot fit", () => {
    // Three columns need 3 x (157px value + 28px of tile padding) + 2 x 12px gap
    // = 579px of container, which is more than any phone has. One column below the
    // breakpoint; the value can also wrap, so the two changes back each other up.
    const threeUp = 3 * (PROFILE_DATE_WIDTH + 28) + 2 * 12;
    expect(threeUp).toBe(579);

    expect(declaration(".profile-stats", "grid-template-columns")).toBe("1fr");
    const [restore] = blockContaining("min-width", [".profile-stats"]);
    // Must be above the widest phone in the sweep (414px), or the date ellipsises.
    expect(restore?.width).toBeGreaterThan(414);
    expect(restore?.body).toMatch(/grid-template-columns:\s*repeat\(3/);
  });
});
