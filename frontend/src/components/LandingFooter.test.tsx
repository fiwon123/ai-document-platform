import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LandingFooter } from "./LandingFooter";
import { SOCIAL_PATHS } from "../content/marketing";

vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));

function renderFooter() {
  return render(
    <MemoryRouter>
      <LandingFooter />
    </MemoryRouter>,
  );
}

/**
 * The footer social row used to read as three circles with an oval in the
 * middle, and the cause was not where it looked. These tests pin the two
 * properties that actually decide whether the glyph lines up with its circular
 * button: the viewBox must match the grid the path was authored on, and all
 * three glyphs must render at the same visual size.
 */

function svgFor(label: string) {
  const node =
    screen.getByLabelText(new RegExp(label)).querySelector("svg") ??
    screen.getByRole("img", { name: new RegExp(label) }).querySelector("svg");
  if (!node) throw new Error(`no svg rendered for ${label}`);
  return {
    viewBox: node.getAttribute("viewBox") ?? "",
    size: Number(node.getAttribute("width")),
  };
}

describe("LandingFooter social icons", () => {
  it("renders all three glyphs at the same 18px display size", () => {
    renderFooter();
    for (const label of ["GitHub", "Twitter", "LinkedIn"]) {
      expect(svgFor(label).size, label).toBe(18);
    }
  });

  it("gives GitHub a 16x16 viewBox to match its 16x16 Octicons path", () => {
    renderFooter();
    // The other two paths are authored on a 24x24 grid. If GitHub shared that
    // viewBox its disc would render at 16/24 of 18px and look undersized.
    expect(svgFor("GitHub").viewBox).toBe("0 0 16 16");
    expect(svgFor("Twitter").viewBox).toBe("0 0 24 24");
    expect(svgFor("LinkedIn").viewBox).toBe("0 0 24 24");
  });

  it("uses the circular disc mark for GitHub, not the egg-shaped Octocat", () => {
    // The glyph used to be the Octocat *silhouette*: a solid blob whose outline
    // is an egg. Its bounding box was almost square (~0.975 w:h) — effectively
    // the same as the disc's — so aspect ratio was never the tell, and no
    // viewBox can fix a silhouette's shape. What changed the read is the outer
    // boundary, so that is what this pins.
    //
    // A disc is built as an explicit circle: move to the top, curve to the left
    // edge, close back with a radius-8 arc spanning the full 16-unit width.
    const d = SOCIAL_PATHS.github;
    expect(d).toMatch(/^M8 0C3\.58 0 0 3\.58 0 8/);
    expect(d).toMatch(/A8\.013 8\.013 0 0 0 16 8c0-4\.42-3\.58-8-8-8Z$/);
  });

  it("authors each glyph on the grid its viewBox declares", () => {
    // A glyph authored on a different grid than its viewBox is rendered
    // scaled-down and wrong-looking, with no error anywhere. These two are the
    // only two grids in use, so pin the pairing for each.
    expect(SOCIAL_PATHS.github).toMatch(/^M8 0/);      // 16x16
    expect(SOCIAL_PATHS.twitter).toMatch(/^M23\.95/);  // 24x24
    expect(SOCIAL_PATHS.linkedin).toMatch(/^M20\.45/); // 24x24
  });

  it("keeps the round button geometry on every social icon", () => {
    renderFooter();
    // The container is what the glyph has to sit inside. All three share it, so
    // it must stay square with a fully rounded border — an oval button would
    // make every glyph look wrong at once.
    for (const label of ["GitHub", "Twitter", "LinkedIn"]) {
      const el =
        screen.getByLabelText(new RegExp(label)) ??
        screen.getByRole("img", { name: new RegExp(label) });
      expect(el.className, label).toContain("footer-social");
    }
  });
});

/**
 * Why the glyph tests above were not enough.
 *
 * #398 fixed the *glyph*: the Octocat silhouette was swapped for the Octicons
 * `mark-github` disc, and GitHub was given a 16x16 viewBox. The icon still read
 * as an oval afterwards, because the oval was never the glyph — the disc was
 * already round to within 2.5%. The actual defect was a CSS specificity
 * conflict one level up, in the button's own box.
 *
 * `.footer-col a` (0,1,1) also matched the brand column's social links and
 * declared `width: fit-content`, outranking `.footer-social` (0,1,0) and its
 * `width: 34px`. `height: 34px` was uncontested, so the button resolved to
 * 20x36px and `border-radius: 50%` drew an ellipse. Twitter and LinkedIn were
 * immune only because they are `<span>` placeholders and the rule matches `a`.
 *
 * These guards read App.css because jsdom does not cascade the real stylesheet
 * (same reason themeTokens.test.ts reads from disk), and because the failure
 * mode is structural: a rule outranking another, which no render assertion can
 * see. The DOM assertions above pass happily against the broken stylesheet.
 */

// Read from disk rather than Vite's `?raw`: CSS imports are stubbed under this
// vitest config, so `?raw` resolves to an empty string.
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Declarations of the rule whose selector list contains `selector` exactly. */
function declarationsFor(selector: string): string[] {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      return (match[2] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);
    }
  }
  throw new Error(`no rule found for selector "${selector}" in App.css`);
}

const valueOf = (decls: string[], prop: string): string | undefined =>
  decls
    .filter((d) => d.startsWith(`${prop}:`))
    .map((d) => d.slice(prop.length + 1).trim())[0];

describe("LandingFooter social button box", () => {
  it("gives .footer-social an explicitly square box and a fully rounded border", () => {
    const decls = declarationsFor(".footer-social");
    const width = valueOf(decls, "width");
    const height = valueOf(decls, "height");

    // A circle needs a square box. These two are load-bearing, not incidental:
    // if either goes missing the border-radius has nothing to stay circular
    // inside. Equal-by-value, so the test fails on 34px vs 35px too.
    expect(width, "width must be declared").toBeDefined();
    expect(height, "height must be declared").toBeDefined();
    expect(width, "width and height must match for a circle").toBe(height);
    expect(valueOf(decls, "border-radius")).toBe("50%");
  });

  it("stops footer-column link rules from reaching the social buttons", () => {
    // The regression, stated as an invariant rather than as a cascade
    // simulation: any rule that sets `width` on a link inside a footer column
    // must be scoped to `nav`, so it cannot leak into the brand column where
    // the social buttons live.
    const offenders: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? "";
      if (!/(^|;)\s*width\s*:/.test(body)) continue;

      for (const selector of (match[1] ?? "").split(",").map((s) => s.trim())) {
        const targetsColumnLink = /\.footer-col\b/.test(selector) && /(^|\s)a(\s|$|:|\[|\.)/.test(selector);
        if (targetsColumnLink && !/(^|\s)nav(\s|$)/.test(selector)) {
          offenders.push(selector);
        }
      }
    }
    // `.footer-col a { width: fit-content }` reintroduced here fails this.
    expect(offenders).toEqual([]);
  });

  it("keeps .footer-social self-sufficient about being a link", () => {
    // GitHub renders as a real <a href>; Twitter and LinkedIn are spans. If the
    // underline suppression is left to a distant `.footer-col a` rule, the
    // button depends on a selector that outranks it and only reaches it by
    // accident — exactly the coupling that caused this bug.
    const decls = declarationsFor(".footer-social");
    expect(valueOf(decls, "text-decoration")).toBe("none");
  });
});
