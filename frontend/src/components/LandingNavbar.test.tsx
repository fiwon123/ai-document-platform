import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingNavbar } from "./LandingNavbar";
import { NAV_PRODUCT } from "../content/marketing";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user }),
}));

let user: { username: string; role: string } | null;

function renderNavbar(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LandingNavbar />
    </MemoryRouter>,
  );
}

/**
 * The menu only opens on hover for real pointer devices, and the global
 * matchMedia stub reports no match. Hover tests have to opt in; the touch
 * regression test opts out explicitly.
 */
function stubHoverPointer(hovers: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: hovers && query === "(hover: hover)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  user = null;
  vi.unstubAllGlobals();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

/**
 * App.css with comments stripped — a comment quoting a selector would otherwise
 * satisfy a guard that is only looking for the text.
 *
 * Read from disk rather than Vite's `?raw`: this vitest config stubs CSS, so
 * `?raw` resolves to an empty string.
 */
const css = readFileSync(resolve(__dirname, "../App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Body of every `@media (max-width: Npx)` block, with the width it applies to. */
function maxWidthBlocks(): { width: number; body: string }[] {
  const blocks: { width: number; body: string }[] = [];
  for (const match of css.matchAll(/@media[^{]*\(max-width:\s*(\d+)px\)[^{]*\{/g)) {
    // Count braces rather than matching to the next `}`: a media body holds
    // nested rules, so a non-greedy regex would stop inside the block.
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    blocks.push({
      width: Number(match[1]),
      body: css.slice(match.index + match[0].length, i - 1),
    });
  }
  return blocks;
}

/** The single `@media (max-width: Npx)` block matching `predicate`. */
function maxWidthBlockWhere(predicate: (body: string) => boolean): {
  width: number;
  body: string;
} {
  const found = maxWidthBlocks().filter((b) => predicate(b.body));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one @media (max-width) block to match, found ${found.length} at ${found
        .map((b) => `${b.width}px`)
        .join(", ")}`,
    );
  }
  return found[0] as { width: number; body: string };
}

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

/** Declarations of the first rule *inside `body`* carrying `selector`. */
function declarationsIn(body: string, selector: string): string[] {
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      return (match[2] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);
    }
  }
  throw new Error(`no rule found for selector "${selector}" in the block`);
}

/** Declarations from *every* rule carrying `selector`, media blocks included. */
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

/** The numeric value of `prop` within `decls`, e.g. 8 for "gap: 8px". */
function valueOf(decls: string[], prop: string): number {
  const decl = decls.find((d) => d.startsWith(`${prop}:`));
  if (decl === undefined) {
    throw new Error(`no "${prop}" in [${decls.join("; ")}]`);
  }
  return Number.parseFloat(decl.slice(prop.length + 1));
}

/** The horizontal component of a `padding` shorthand, e.g. "6vw". */
function paddingX(decls: string[]): string {
  const decl = decls.find((d) => d.startsWith("padding:"));
  if (decl === undefined) {
    throw new Error(`no "padding" in [${decls.join("; ")}]`);
  }
  return decl
    .slice("padding:".length)
    .trim()
    .split(/\s+/)[1] as string;
}
afterEach(() => {
  vi.useRealTimers();
});

describe("LandingNavbar", () => {
  it("shows the brand, the flat Product links, and the Company menu", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    // Product is a flat list, not a second menu: its destinations are the
    // header's primary content and must be visible without interaction.
    for (const label of ["Overview", "Features", "How it works", "Pricing", "Live demo"]) {
      expect(screen.getByRole("link", { name: label }), label).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /Product/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Company/ })).toBeTruthy();
  });

  it("points each flat Product link at its own page", () => {
    renderNavbar();
    for (const [label, href] of [
      ["Overview", "/product"],
      ["Features", "/features"],
      ["How it works", "/how-it-works"],
      ["Pricing", "/pricing"],
      ["Live demo", "/demo"],
    ] as const) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href"), label).toBe(
        href,
      );
    }
  });

  it("keeps the Company menu's children hidden until it is opened", async () => {
    renderNavbar();
    // The Company section is still a disclosure, so nothing of its is on screen
    // that the visitor did not ask for.
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.getByRole("link", { name: "Careers" }).getAttribute("href")).toBe(
      "/careers",
    );
  });

  it("exposes the Company hub as the overview link", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.getByRole("link", { name: "Company overview" }).getAttribute("href")).toBe(
      "/company",
    );
  });

  it("composes the Overview link instead of adding one to NAV_PRODUCT", () => {
    renderNavbar();
    // The header composes its Overview link rather than adding one to
    // NAV_PRODUCT, because the footer derives the same link from its column's
    // `hub` field. Editing the shared array would render it twice down there.
    const navLinks = document.querySelectorAll(".nav-flat a");
    expect(navLinks.length).toBe(NAV_PRODUCT.length + 1);
    expect(NAV_PRODUCT.map((item) => item.to)).not.toContain("/product");
  });

  it("lets the flat group wrap instead of overflowing on a narrow row", () => {
    // Five links plus a menu will not fit on a phone. jsdom does not lay out, so
    // this reads the stylesheet: `flex-wrap` is the only thing standing between
    // the wider flat list and a horizontally scrolling header.
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) =>
      (m[1] ?? "").split(",").some((s) => s.trim() === ".nav-flat"),
    );
    expect(rule, "no .nav-flat rule in App.css").toBeDefined();
    expect(rule?.[2] ?? "").toMatch(/flex-wrap\s*:\s*wrap/);
  });

  // The three tests below cover the 850-1024px wrapping band. jsdom performs no
  // layout, so none of them can assert "one row" — a `scrollWidth === clientWidth`
  // assertion would pass vacuously (0 === 0). Each pins the MECHANISM in the
  // stylesheet instead, and the invariant itself was verified in headless
  // Chromium: the flat list measures one row (one distinct rounded `top` among
  // its children) and 80.2px of navbar at every width from 901px to 1200px, in
  // both the logged-out and the logged-in state, with 0px deficit and nothing
  // clipped. See the comment on each test for the measurement it rests on.

  it("buys its width in the compact band instead of wrapping the navbar", () => {
    // Measured at a 1024px viewport before this band existed: the flat group
    // needed 409px and the row gave it 371px, so the last link wrapped and the
    // navbar grew 82px -> 105px. Gaps alone recover ~100px, so the band also
    // drops the secondary CTA — the one button the footer still links to.
    const band = maxWidthBlockWhere((body) => body.includes(".nav-flat"));

    // Relational, not pinned numbers: any tightening counts, so a later design
    // tweak need not edit this test. What must not happen is the band re-widening
    // the spacing it exists to shrink.
    expect(
      valueOf(declarationsIn(band.body, ".nav-flat"), "gap"),
      "band .nav-flat gap",
    ).toBeLessThan(valueOf(declarationsFor(".nav-flat"), "gap"));
    expect(
      valueOf(declarationsIn(band.body, ".landing-navbar"), "gap"),
      "band .landing-navbar gap",
    ).toBeLessThan(valueOf(declarationsFor(".landing-navbar"), "gap"));
    expect(
      valueOf(declarationsIn(band.body, ".landing-nav-links"), "gap"),
      "band .landing-nav-links gap",
    ).toBeLessThan(valueOf(declarationsFor(".landing-nav-links"), "gap"));

    // The band has to hide a CTA to reach one row; assert it does rather than
    // leaving the shortfall to be discovered in a browser again.
    expect(declarationsIn(band.body, ".landing-nav-actions .btn-secondary")).toContain(
      "display: none",
    );

    // And it has to reach past the widest width in the bug report. The old
    // gap-only steps stopped at 1200px but still left a ~37px deficit from 1025px
    // to ~1051px, so a band ending below 1024px would leave those widths on the
    // base spacing that wrapped.
    expect(band.width).toBeGreaterThanOrEqual(1024);
  });

  it("collapses the navbar and the Company menu at the same width", () => {
    // The two breakpoints are one contract: when the nav row wraps to full
    // width, an absolutely positioned dropdown opens off-screen. Measured: the
    // menu is `position: static` at <=900px and `absolute` at 901px, fully inside
    // the viewport either way. Raising one block and not the other reintroduces
    // an off-screen panel that no DOM test can see, so pin the equality rather
    // than either width.
    const collapse = maxWidthBlockWhere(
      (body) => body.includes(".landing-navbar") && /flex-wrap\s*:\s*wrap/.test(body),
    );
    const dropdown = maxWidthBlockWhere(
      (body) => body.includes(".nav-group-menu") && /position\s*:\s*static/.test(body),
    );
    expect(
      collapse.width,
      "navbar wrap and dropdown breakpoints must match",
    ).toBe(dropdown.width);
  });

  it("keeps the navbar gutter aligned with the page's own gutter", () => {
    // The compact band tightens gaps but must NOT narrow the navbar's horizontal
    // padding: `.landing-section` pads by the same `6vw`, so a narrower navbar
    // gutter would pull the brand and links out of line with the copy directly
    // below them. Asserted as "the same horizontal value", not "6vw", so a
    // deliberate change to both stays legal; and declared exactly once, so no
    // breakpoint can quietly re-narrow one side only.
    const navbarPads = allDeclarationsFor(".landing-navbar").filter((d) =>
      d.startsWith("padding"),
    );
    expect(
      navbarPads,
      "padding declared more than once for .landing-navbar — a breakpoint is re-narrowing the gutter",
    ).toHaveLength(1);
    expect(paddingX(declarationsFor(".landing-navbar"))).toBe(
      paddingX(declarationsFor(".landing-section")),
    );
  });

  it("marks the current flat link, not a menu trigger, on Product routes", () => {
    for (const [path, label] of [
      ["/product", "Overview"],
      ["/features", "Features"],
      ["/how-it-works", "How it works"],
      ["/pricing", "Pricing"],
      ["/demo", "Live demo"],
    ] as const) {
      const { unmount } = renderNavbar(path);
      const current = screen.getByRole("link", { name: label });
      expect(current.getAttribute("aria-current"), `aria-current on ${path}`).toBe(
        "page",
      );
      expect(current.className, `active class on ${path}`).toMatch(/active/);
      unmount();
    }
  });

  it("marks the Company trigger active on its own routes", () => {
    for (const path of ["/company", "/about", "/careers", "/contact"]) {
      const { unmount } = renderNavbar(path);
      expect(
        screen.getByRole("button", { name: /Company/ }).className,
        `expected Company to be active on ${path}`,
      ).toMatch(/active/);
      unmount();
    }
  });

  it("leaves nothing marked active on an unrelated route", () => {
    renderNavbar("/privacy");
    expect(screen.getByRole("button", { name: /Company/ }).className).not.toMatch(
      /active/,
    );
    for (const link of document.querySelectorAll(".nav-flat a")) {
      expect(link.className).not.toMatch(/active/);
    }
  });

  it("reports open state through aria-expanded", async () => {
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Company/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Company/ });
    await userEvent.click(trigger);
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
    // Focus must come back, or Escape strands the user at the top of the page.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a click lands outside the menu", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();

    await userEvent.click(screen.getByText("AskDocs"));
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
  });

  // Company is the only header disclosure left — Product is a flat list — so the
  // hover-gap behaviour is asserted against its one remaining trigger. The gap bug
  // was never a section-specific quirk: it lives in `NavGroupMenu`, and any future
  // section that reuses that component inherits the same coverage from here.
  {
    const section = /Company/;
    const child = "Careers";
    it(`opens on hover for pointer devices (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      expect(screen.queryByRole("link", { name: child })).toBeNull();

      await userEvent.hover(screen.getByRole("button", { name: section }));
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
    });

    it(`stays open travelling from trigger to menu (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      // The menu is offset 10px below the trigger, so the pointer leaves the
      // container while crossing the gap. A naive mouseleave close would fire
      // there; the deferred close is what keeps the menu up long enough to arrive.
      await userEvent.hover(screen.getByRole("button", { name: section }));
      await userEvent.hover(document.querySelector(".nav-group-menu") as Element);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
    });

    it(`closes once the pointer leaves trigger and menu (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });
      await userEvent.hover(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();

      await userEvent.unhover(trigger);
      await userEvent.unhover(document.querySelector(".nav-group-menu") as Element);
      // Deferred, so run the timer rather than asserting synchronously.
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole("link", { name: child })).toBeNull();
    });

    it(`does not open on hover on touch devices (${section.source})`, async () => {
      stubHoverPointer(false);
      renderNavbar();
      // A touch device has no hover: opening on hover there would make the menu
      // appear under a tap and be hard to dismiss.
      await userEvent.hover(screen.getByRole("button", { name: section }));
      expect(screen.queryByRole("link", { name: child })).toBeNull();

      // Clicking still works, so the menu is reachable on touch.
      await userEvent.click(screen.getByRole("button", { name: section }));
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
    });
  }

  it("keeps legal pages out of the header", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Privacy Policy" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
  });

  it("links to demo, login, and sign up for anonymous visitors", () => {
    renderNavbar();
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      "/login",
    );
  });

  it("shows a shortcut back to the app for signed-in visitors", () => {
    user = { username: "alice", role: "customer" };
    renderNavbar();
    expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to app" }).getAttribute("href")).toBe(
      "/app",
    );
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Company/ });
    await userEvent.click(trigger);
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
    // Focus must come back, or Escape strands the user at the top of the page.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a click lands outside the menu", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();

    await userEvent.click(screen.getByText("AskDocs"));
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
  });

  it("opens on hover for pointer devices", async () => {
    stubHoverPointer(true);
    renderNavbar();
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();

    await userEvent.hover(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();
  });

  it("stays open while the pointer travels from trigger to menu", async () => {
    stubHoverPointer(true);
    renderNavbar();
    // The menu is offset 10px below the trigger, so the pointer leaves the
    // container while crossing the gap. A naive mouseleave close would fire
    // there; the deferred close is what keeps the menu up long enough to arrive.
    await userEvent.hover(screen.getByRole("button", { name: /Company/ }));
    await userEvent.hover(document.querySelector(".nav-group-menu") as Element);
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();
  });

  it("closes once the pointer leaves both trigger and menu", async () => {
    stubHoverPointer(true);
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Company/ });
    await userEvent.hover(trigger);
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();

    await userEvent.unhover(trigger);
    await userEvent.unhover(document.querySelector(".nav-group-menu") as Element);
    // Deferred, so run the timer rather than asserting synchronously.
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
  });

  it("does not open on hover on touch devices", async () => {
    stubHoverPointer(false);
    renderNavbar();
    // A touch device has no hover: opening on hover there would make the menu
    // appear under a tap and be hard to dismiss.
    await userEvent.hover(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();

    // Clicking still works, so the menu is reachable on touch.
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();
  });

  it("keeps legal pages out of the header", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.queryByRole("link", { name: "Privacy Policy" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Security" })).toBeNull();
  });

  it("links to demo, login, and sign up for anonymous visitors", () => {
    renderNavbar();
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      "/login",
    );
  });

  it("shows a shortcut back to the app for signed-in visitors", () => {
    user = { username: "alice", role: "customer" };
    renderNavbar();
    expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to app" }).getAttribute("href")).toBe(
      "/app",
    );
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
  });
});
