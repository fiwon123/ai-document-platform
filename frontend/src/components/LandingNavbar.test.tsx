import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingNavbar } from "./LandingNavbar";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("LandingNavbar", () => {
  it("shows the brand and both section menus", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Product/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Company/ })).toBeTruthy();
  });

  it("keeps child pages hidden until a menu is opened", async () => {
    renderNavbar();
    // Flat links are always visible. They live behind the menus, so nothing is on
    // screen that the visitor did not ask for.
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Pricing" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Product/ }));
    expect(screen.getByRole("link", { name: "Features" }).getAttribute("href")).toBe(
      "/features",
    );
    expect(screen.getByRole("link", { name: "How it works" }).getAttribute("href")).toBe(
      "/how-it-works",
    );
    expect(screen.getByRole("link", { name: "Pricing" }).getAttribute("href")).toBe(
      "/pricing",
    );
    expect(screen.getByRole("link", { name: "Live demo" }).getAttribute("href")).toBe(
      "/demo",
    );
  });

  it("exposes each section hub as the overview link", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Product/ }));
    expect(screen.getByRole("link", { name: "Product overview" }).getAttribute("href")).toBe(
      "/product",
    );

    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.getByRole("link", { name: "Company overview" }).getAttribute("href")).toBe(
      "/company",
    );
    expect(screen.getByRole("link", { name: "Careers" }).getAttribute("href")).toBe(
      "/careers",
    );
  });

  it("marks a section trigger active on its own routes", () => {
    for (const [path, section] of [
      ["/product", /Product/],
      ["/features", /Product/],
      ["/how-it-works", /Product/],
      ["/pricing", /Product/],
      ["/demo", /Product/],
      ["/company", /Company/],
      ["/about", /Company/],
      ["/careers", /Company/],
    ] as const) {
      const { unmount } = renderNavbar(path);
      const trigger = screen.getByRole("button", { name: section });
      expect(
        trigger.className,
        `expected ${section} to be active on ${path}`,
      ).toMatch(/active/);
      unmount();
    }
  });

  it("does not mark a section active on another section's routes", () => {
    renderNavbar("/privacy");
    for (const section of [/Product/, /Company/]) {
      expect(screen.getByRole("button", { name: section }).className).not.toMatch(
        /active/,
      );
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

  // Both header sections are disclosure menus, so the hover-gap behaviour has to
  // hold for each of them. Parameterised rather than duplicated: the gap bug is
  // not a Company-specific quirk, and a test that only covered one trigger would
  // not have caught a regression in the other.
  for (const [section, child] of [
    [/Product/, "Features"],
    [/Company/, "Careers"],
  ] as const) {
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
