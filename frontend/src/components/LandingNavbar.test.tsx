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
    // The compact band is identified by what it *does* — it drops the secondary
    // CTA to buy its width — rather than by merely mentioning `.nav-flat`, which
    // the <=900px collapse also does (#557 turned that band into a disclosure
    // panel, so `.nav-flat` is now a stacked list rather than a tightened row).
    const band = maxWidthBlockWhere((body) =>
      body.includes(".landing-nav-actions .btn-secondary"),
    );

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
    // The two breakpoints are one contract: at the collapse width the links move
    // off the row entirely, and an absolutely positioned dropdown opens
    // off-screen relative to a row that no longer holds it. Measured: the menu is
    // `position: static` at <=900px and `absolute` at 901px, fully inside the
    // viewport either way. Raising one block and not the other reintroduces an
    // off-screen panel that no DOM test can see, so pin the equality rather than
    // either width.
    //
    // The collapse used to be identified by `flex-wrap: wrap` on the navbar, and
    // still is: wrapping is what lets the panel reach a line of its own. Setting
    // it to `nowrap` looks harmless — the row itself fits — but the panel is a
    // sibling in that row, so it is then shrunk to min-content and overflows the
    // viewport. Asserting `display: none` on the links as well is what makes the
    // two widths matching mean something: it proves the nav row actually stops
    // showing the links at this width.
    const collapse = maxWidthBlockWhere(
      (body) => body.includes(".landing-navbar") && /flex-wrap\s*:\s*wrap/.test(body),
    );
    const dropdown = maxWidthBlockWhere(
      (body) => body.includes(".nav-group-menu") && /position\s*:\s*static/.test(body),
    );
    expect(
      collapse.width,
      "navbar collapse and dropdown breakpoints must match",
    ).toBe(dropdown.width);

    // And the collapse must actually hide the links, or the two widths matching
    // would prove nothing at all. `valueOf` is numeric, so read the raw
    // declaration list for a non-numeric value like `none`.
    expect(declarationsIn(collapse.body, ".landing-nav-links")).toContain(
      "display: none",
    );
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

    /* ── #591: a click must never be a no-op ──────────────────────────────────
       Every pointer interaction begins with a move onto the element, so for a
       mouse the click always arrives *after* hover has already opened the menu.
       A plain toggle therefore closed what the pointer had just opened, and the
       click did nothing observable. These cover the mouse path specifically: the
       pre-existing `aria-expanded` test stubs hover *off*, so it never produced
       the sequence that was broken and could not have caught it. */
    it(`stays open when a click follows the hover that opened it (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });

      await userEvent.hover(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();

      // `userEvent.click` moves the pointer onto the element first, which is the
      // real sequence: the click's own mouseenter is a no-op here, so what is
      // under test is the click handler's response to an already-hover-opened menu.
      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it(`keeps a click-opened menu open when the pointer leaves (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });
      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();

      await userEvent.unhover(trigger);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      // Hover dismissal is for a menu the pointer borrowed. A click pins it, and
      // pinning is what makes the click mean something — without this, the click
      // would open a menu that the next pointer move silently closed again.
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
    });

    it(`closes a click-opened menu on the next click (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });

      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it(`opens from closed on the first click after the pointer arrives (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });
      expect(screen.queryByRole("link", { name: child })).toBeNull();

      // The sequence that was inverted: arrive, then click. It closed before.
      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();
    });

    it(`still dismisses a click-opened menu with Escape and an outside click (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });

      await userEvent.click(trigger);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("link", { name: child })).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await userEvent.click(trigger);
      await userEvent.click(screen.getByText("AskDocs"));
      expect(screen.queryByRole("link", { name: child })).toBeNull();
    });

    // Pinning is per route: arriving on a different path must clear it, or
    // hover dismissal stops working on every page of a section after one click.
    it(`does not carry a click-opened menu across navigation (${section.source})`, async () => {
      stubHoverPointer(true);
      renderNavbar();
      const trigger = screen.getByRole("button", { name: section });

      await userEvent.click(trigger);
      expect(screen.queryByRole("link", { name: child })).not.toBeNull();

      // Navigate from inside the menu. The menu closes, because it was opened
      // for the path we left — and the pin goes with it.
      await userEvent.click(screen.getByRole("link", { name: child }));
      expect(screen.queryByRole("link", { name: child })).toBeNull();
      await userEvent.unhover(trigger);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole("link", { name: child })).toBeNull();
    });
  }

  /* Keyboard. No pointer, so no hover — the one path that already worked, and
     the one that makes the mouse failure a defect rather than a preference:
     the control had a working route and a dead one, differing only in input
     modality. Held here so a change to the click path cannot quietly break the
     keyboard one. */
  it("toggles from the keyboard, with no hover involved", async () => {
    stubHoverPointer(true);
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Company/ });
    trigger.focus();

    // Enter fires the button's click handler, so it takes the same pin path as a
    // mouse. It must not depend on a hover that never happened.
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("link", { name: "Careers" })).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("link", { name: "Careers" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
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
    // Exactly one demo CTA in the header, and it points at /demo. The mobile
    // panel has no "Try the demo" button of its own: `NAV_PRODUCT` already puts a
    // "Live demo" link to the same place two rows into the panel, so a second
    // control would be the same destination twice in one 400px menu. `getByRole`
    // rather than `getAllByRole` is the assertion that holds that — it throws if
    // a duplicate ever comes back, which `toBeGreaterThan(1)` would have blessed.
    const demoLinks = screen.getAllByRole("link", { name: "Try the demo" });
    expect(demoLinks).toHaveLength(1);
    expect(demoLinks[0]!.getAttribute("href")).toBe("/demo");
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
    // Exactly one demo CTA in the header, and it points at /demo. The mobile
    // panel has no "Try the demo" button of its own: `NAV_PRODUCT` already puts a
    // "Live demo" link to the same place two rows into the panel, so a second
    // control would be the same destination twice in one 400px menu. `getByRole`
    // rather than `getAllByRole` is the assertion that holds that — it throws if
    // a duplicate ever comes back, which `toBeGreaterThan(1)` would have blessed.
    const demoLinks = screen.getAllByRole("link", { name: "Try the demo" });
    expect(demoLinks).toHaveLength(1);
    expect(demoLinks[0]!.getAttribute("href")).toBe("/demo");
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
    // Exactly one demo CTA in the header, and it points at /demo. The mobile
    // panel has no "Try the demo" button of its own: `NAV_PRODUCT` already puts a
    // "Live demo" link to the same place two rows into the panel, so a second
    // control would be the same destination twice in one 400px menu. `getByRole`
    // rather than `getAllByRole` is the assertion that holds that — it throws if
    // a duplicate ever comes back, which `toBeGreaterThan(1)` would have blessed.
    const demoLinks = screen.getAllByRole("link", { name: "Try the demo" });
    expect(demoLinks).toHaveLength(1);
    expect(demoLinks[0]!.getAttribute("href")).toBe("/demo");
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
    // Exactly one demo CTA in the header, and it points at /demo. The mobile
    // panel has no "Try the demo" button of its own: `NAV_PRODUCT` already puts a
    // "Live demo" link to the same place two rows into the panel, so a second
    // control would be the same destination twice in one 400px menu. `getByRole`
    // rather than `getAllByRole` is the assertion that holds that — it throws if
    // a duplicate ever comes back, which `toBeGreaterThan(1)` would have blessed.
    const demoLinks = screen.getAllByRole("link", { name: "Try the demo" });
    expect(demoLinks).toHaveLength(1);
    expect(demoLinks[0]!.getAttribute("href")).toBe("/demo");
  });

});

/* ── #557: the mobile disclosure panel ─────────────────────────────────────
   The header used to move its links to their own full-width row and let them
   wrap: at 375px that was three rendered lines and 241px of an 812px viewport —
   30% of the screen, before any content. The nav had nowhere to go, so it
   spilled instead of collapsing.

   These pin the collapse itself. The width arithmetic that decides *what* fits
   in the row is verified in a browser (see the block comment in App.css); what
   is testable here is that a control exists, that it is a real disclosure, and
   that the panel's contents are out of the way until it is opened. */
describe("LandingNavbar mobile panel (#557)", () => {
  const toggle = () =>
    screen.getByRole("button", { name: /navigation menu/i });

  it("exposes the nav links behind a labelled disclosure button", () => {
    renderNavbar();
    const button = toggle();
    // APG "Navigation Menu Button": a real button, wired to the panel it
    // reveals, and reporting its state. A bare hamburger icon with no
    // aria-expanded is the failure mode this assertion exists to catch.
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("landing-nav-links");
    expect(document.getElementById("landing-nav-links")).not.toBeNull();
  });

  it("toggles aria-expanded and the panel class", async () => {
    renderNavbar();
    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById("landing-nav-links")?.className,
    ).toContain("landing-nav-links-open");

    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(
      document.getElementById("landing-nav-links")?.className,
    ).not.toContain("landing-nav-links-open");
  });

  it("moves focus to the first panel link and returns it on Escape", async () => {
    renderNavbar();
    const button = toggle();
    await userEvent.click(button);
    // Focus moves *into* the panel, so a keyboard user is not left tabbing
    // through the page behind an open menu.
    const panel = document.getElementById("landing-nav-links")!;
    expect(panel.contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("closes on navigation, so a route change cannot leave it hanging open", async () => {
    renderNavbar("/pricing");
    await userEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    // Openness is keyed to the path it was opened for, so following a panel
    // link closes it without a setState-in-effect.
    await userEvent.click(screen.getAllByRole("link", { name: "Features" })[0]!);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps every destination reachable from the panel", async () => {
    renderNavbar();
    await userEvent.click(toggle());
    const panel = document.getElementById("landing-nav-links")!;
    const hrefs = [...panel.querySelectorAll("a[href]")].map((a) =>
      a.getAttribute("href"),
    );

    // The acceptance criterion is reachability, so assert the set of
    // destinations rather than that some links exist.
    for (const to of ["/product", "/demo"]) {
      expect(hrefs, `panel must reach ${to}`).toContain(to);
    }
    for (const item of NAV_PRODUCT) {
      expect(hrefs, `panel must reach ${item.to}`).toContain(item.to);
    }
  });

  it("carries the theme toggle the row cannot afford, and no duplicate demo CTA", async () => {
    renderNavbar();
    await userEvent.click(toggle());
    const panel = document.getElementById("landing-nav-links")!;
    const actions = panel.querySelector(".landing-nav-panel-actions");
    expect(actions?.querySelector(".theme-toggle")).not.toBeNull();
    // The demo is reachable from the header below 1200px — via `NAV_PRODUCT`'s
    // "Live demo" link, which the panel already renders. What must NOT be here is
    // a second control for that same destination: one acceptance criterion is
    // that the demo CTA stays present or is deliberately replaced by an
    // equivalent, and a duplicate is neither of those things.
    expect(actions?.querySelector('a[href="/demo"]')).toBeNull();
    expect(
      [...panel.querySelectorAll(".nav-flat a[href='/demo']")].length,
      "one 'Live demo' link in the panel",
    ).toBe(1);
  });

  it("gives the hamburger a visible open state, not just aria-expanded", () => {
    renderNavbar();
    // `aria-expanded` is invisible to everyone who can see but cannot use a
    // screen reader — which is most people, on the one control whose entire job
    // is to say whether the panel is open. Pin the transform that draws the X,
    // matching `.navbar-toggle`, so the signal cannot silently disappear.
    for (const child of [1, 2, 3]) {
      const selector = `.landing-nav-toggle[aria-expanded="true"] .landing-nav-toggle-bar:nth-child(${child})`;
      expect(
        declarationsFor(selector).join(";"),
        `open-state bar ${child}`,
      ).not.toBe("");
    }
    // The middle bar vanishes and the outer two cross: that pair is the X.
    const top = declarationsFor(
      '.landing-nav-toggle[aria-expanded="true"] .landing-nav-toggle-bar:nth-child(1)',
    ).join(";");
    expect(top).toContain("rotate(45deg)");
    expect(top).toContain("translateY(6px)");
    expect(
      declarationsFor(
        '.landing-nav-toggle[aria-expanded="true"] .landing-nav-toggle-bar:nth-child(2)',
      ),
    ).toContain("opacity: 0");
    expect(
      declarationsFor(
        '.landing-nav-toggle[aria-expanded="true"] .landing-nav-toggle-bar:nth-child(3)',
      ).join(";"),
    ).toContain("rotate(-45deg)");
    // And the toggled label, which is what a screen reader does get.
    expect(screen.getByRole("button", { name: "Open navigation menu" })).not.toBeNull();
  });

  it("hides the panel's own controls and the hamburger above the collapse width", () => {
    // The collapse must be additive. If either the toggle or the panel's extra
    // controls were visible by default, the desktop row would show a hamburger
    // and a second theme toggle at every width — and #424 budgeted that row to
    // an exact 80.2/82.2px height that a 44px toggle would grow.
    expect(
      declarationsFor(".landing-nav-toggle"),
      ".landing-nav-toggle display",
    ).toContain("display: none");
    expect(
      declarationsFor(".landing-nav-panel-actions"),
      ".landing-nav-panel-actions display",
    ).toContain("display: none");
  });

  it("shows the hamburger inside the 900px collapse and nowhere else", () => {
    const blocks = maxWidthBlocks().filter((b) =>
      b.body.includes(".landing-nav-toggle"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.width).toBe(900);
    expect(blocks[0]!.body).toMatch(
      /\.landing-nav-toggle\s*\{[^}]*display:\s*inline-flex/,
    );
  });

  it("moves the row's theme toggle into the panel, because the row cannot hold both", () => {
    // The arithmetic (App.css, measured in Chromium at 375px): the row is
    // brand + hamburger + CTA = 286.9px against a 330px content box, which
    // leaves 43px. Adding the 44px toggle and its 12px gap makes it 342.9 —
    // a 13px overflow at the width this breakpoint exists to serve, and only for
    // signed-in visitors. So the secondary control moves and the primary CTA
    // stays. Pin the direction of that trade so it is not silently reversed.
    const collapse = maxWidthBlockWhere((body) =>
      body.includes(".landing-nav-panel-actions"),
    );
    expect(collapse.width).toBe(900);
    expect(
      declarationsIn(collapse.body, ".landing-nav-actions .theme-toggle"),
      "row theme toggle inside the collapse",
    ).toContain("display: none");
  });
});
