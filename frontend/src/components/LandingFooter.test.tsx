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
 * Two stylesheet-level guards follow, one per defect that a render assertion
 * cannot see: the social button's box (#401) and the subscribe row's alignment
 * (#402). jsdom does not cascade the real stylesheet, and both failure modes
 * are structural — a rule outranking another, a flex alignment — so these read
 * App.css from disk, the same approach themeTokens.test.ts uses (and the reason
 * tsconfig.app.json includes the "node" types). The DOM assertions above pass
 * happily against a broken stylesheet.
 *
 * Read from disk rather than Vite's `?raw`: CSS imports are stubbed under this
 * vitest config, so `?raw` resolves to an empty string.
 */
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Declarations of the first rule whose selector list contains `selector`. */
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

/** Declarations from *every* rule carrying `selector`. `.newsletter` appears in
 *  the base rule and again in the <=820px media query, and a `center` in either
 *  one re-creates the float, so both have to be seen. */
function allDeclarationsFor(selector: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      found.push(
        ...(match[2] ?? "")
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean),
      );
    }
  }
  if (found.length === 0) {
    throw new Error(`no rule found for selector "${selector}" in App.css`);
  }
  return found;
}

/** All values declared for `prop` — a rule may set it more than once across
 *  breakpoints, so this stays a list. */
const valuesOf = (decls: string[], prop: string): string[] =>
  decls
    .filter((d) => d.startsWith(`${prop}:`))
    .map((d) => d.slice(prop.length + 1).trim());

/** First value declared for `prop`, for properties that are not breakpoint-
 *  dependent. */
const valueOf = (decls: string[], prop: string): string | undefined =>
  valuesOf(decls, prop)[0];

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
    //
    // `.footer-col a` (0,1,1) matched the brand column's social links and
    // declared `width: fit-content`, outranking `.footer-social` (0,1,0) and its
    // `width: 34px`. `height: 34px` was uncontested, so the button resolved to
    // 20x36px and `border-radius: 50%` drew an ellipse. Twitter and LinkedIn
    // were immune only because they are `<span>` placeholders and the rule
    // matches `a`.
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

describe("LandingFooter subscribe form", () => {
  it("sits inside the brand column instead of spanning the footer", () => {
    // As a sibling of the columns the signup got a hairline and a full-width row
    // to itself, which framed an optional form as the footer's headline. It now
    // fills the empty space under the social icons in the widest column (2fr),
    // which the nav columns next to it had left blank.
    renderFooter();
    const footer = document.querySelector(".landing-footer");
    const newsletter = document.querySelector(".newsletter");

    expect(newsletter, "newsletter form").not.toBeNull();
    expect(newsletter?.parentElement, "newsletter's parent").toBe(
      document.querySelector(".footer-brand"),
    );
    // Still genuinely a child of the footer, just one level deeper — catches a
    // future edit that detaches it without moving it anywhere useful.
    expect(footer?.contains(newsletter as Node)).toBe(true);
  });

  it("comes after the social icons, so the links read before the invitation", () => {
    renderFooter();
    const brand = document.querySelector(".footer-brand");
    const socials = brand?.querySelector(".footer-socials");
    const newsletter = brand?.querySelector(".newsletter");

    expect(socials, "social icons").not.toBeNull();
    expect(newsletter, "newsletter form").not.toBeNull();
    // compareDocumentPosition rather than an index into children: it asserts
    // document order without depending on which sibling tags sit between them.
    // The `&&` chain narrows both to non-null, which the bitwise `&` requires.
    const follows = Boolean(
      socials &&
        newsletter &&
        (socials.compareDocumentPosition(newsletter) &
          Node.DOCUMENT_POSITION_FOLLOWING),
    );
    expect(follows, "newsletter follows the social icons").toBe(true);
  });

  it("leaves only the columns and the copyright row as the footer's children", () => {
    renderFooter();
    const order = Array.from(
      document.querySelectorAll(".landing-footer > *"),
    ).map((el) => el.className);

    // The form is no longer a top-level block, so it must not appear here. An
    // extra sibling would be a new band across the footer — the thing this
    // change removed.
    expect(order).toEqual(["footer-cols", "footer-bottom"]);
  });

  it("stacks heading, promise, and form down the column", () => {
    // Each part is a step, so the column reads top to bottom rather than the
    // form sitting beside the copy as a wide two-column band did.
    expect(valuesOf(declarationsFor(".newsletter"), "flex-direction")).toEqual([
      "column",
    ]);
  });

  it("stays stacked at every breakpoint", () => {
    const directions = valuesOf(allDeclarationsFor(".newsletter"), "flex-direction");
    // Length matters as much as content: an absent declaration would fall
    // through to `row` and undo the layout at the default breakpoint.
    expect(directions.length).toBeGreaterThan(0);
    expect(directions.every((d) => d === "column")).toBe(true);
  });

  it("has no separator edge now that it is a block inside a column", () => {
    // The hairline only made sense while the form was a band of its own. Left
    // in place it would draw a rule across the middle of the brand column.
    const decls = declarationsFor(".newsletter");
    expect(valuesOf(decls, "border-top")).toEqual([]);
    expect(valuesOf(decls, "border-bottom")).toEqual([]);
  });

  it("grows the email field into the column instead of a fixed width", () => {
    // `min-width: 0` is the part that matters: a flex item's automatic minimum
    // size is its content width, so an input without it refuses to shrink below
    // the default `size` and can push the button past the column edge.
    const decls = declarationsFor(".newsletter-form input");
    expect(valueOf(decls, "flex")).toBe("1");
    expect(valueOf(decls, "min-width")).toBe("0");
    expect(valuesOf(decls, "width")).toEqual([]);
  });

  it("keeps the input and button in one flex row so their heights can match", () => {
    renderFooter();
    // The input and the button are already the same height — the input is
    // intrinsically 42.88px, and the button (40.88px, `border: none`) stretches
    // to match under `.newsletter-form`'s default `align-items: stretch`. That
    // is load-bearing, not incidental: pull the button out of the row and the
    // two controls are 2px apart with nothing left to equalise them. It is the
    // reason the form row survives a change that stacked everything else.
    const form = document.querySelector(".newsletter-form");
    expect(form, "newsletter form row").not.toBeNull();
    expect(form?.querySelector("input"), "input inside the row").not.toBeNull();
    expect(form?.querySelector("button"), "button inside the row").not.toBeNull();
  });

  it("keeps the form's own row, never a breakpoint override", () => {
    // The <=820px block used to force `flex-direction: column` on `.newsletter`
    // and re-declare the form's width and the input's. All three are now the
    // default, so the overrides were removed; if any comes back it means the
    // base rule and the breakpoint disagree about the same property, which is
    // how the two controls lost their shared line in the first place.
    const directions = valuesOf(
      allDeclarationsFor(".newsletter-form"),
      "flex-direction",
    );
    expect(directions).not.toContain("column");

    const formWidths = valuesOf(allDeclarationsFor(".newsletter-form"), "width");
    expect(formWidths.every((w) => w === "100%")).toBe(true);
    expect(formWidths.length, "a width is declared").toBeGreaterThan(0);
  });
});
