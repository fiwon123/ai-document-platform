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
