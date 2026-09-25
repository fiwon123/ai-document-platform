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
  it("shows the brand, a direct Product link, and the Company menu", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();

    // Product is a single destination, so it is a link — not a button that opens
    // a one-item menu. A menu here would be a control that hides one link.
    const product = screen.getByRole("link", { name: /Product/ });
    expect(product.getAttribute("href")).toBe("/product");

    // Company still has children, so it keeps the disclosure button.
    expect(screen.getByRole("button", { name: /Company/ })).toBeTruthy();
  });

  it("keeps Product child pages hidden until Company is opened", async () => {
    renderNavbar();
    // The old flat links were always visible. They now live behind the Company
    // menu, so nothing is on screen that the visitor did not ask for.
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Pricing" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.getByRole("link", { name: "Careers" }).getAttribute("href")).toBe(
      "/careers",
    );
    expect(screen.getByRole("link", { name: "Contact" }).getAttribute("href")).toBe(
      "/contact",
    );
  });

  it("exposes the Company hub as the overview link", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Company/ }));
    expect(screen.getByRole("link", { name: "Company overview" }).getAttribute("href")).toBe(
      "/company",
    );
    expect(screen.getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about");
    expect(screen.getByRole("link", { name: "Blog" }).getAttribute("href")).toBe("/blog");
  });

  it("keeps every Product child reachable from the footer", () => {
    // Removing the Product menu must not remove the routes themselves — the
    // footer is the remaining path to /features, /how-it-works and /pricing.
    renderNavbar();
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
  });

  it("marks the Product link active on every Product child route", () => {
    for (const path of ["/product", "/features", "/how-it-works", "/pricing", "/demo"]) {
      const { unmount } = renderNavbar(path);
      const link = screen.getByRole("link", { name: /Product/ });
      expect(
        link.className,
        `expected the Product link to be active on ${path}`,
      ).toMatch(/active/);
      unmount();
    }
  });

  it("does not mark Product active on Company or Legal routes", () => {
    renderNavbar("/privacy");
    expect(screen.getByRole("link", { name: /Product/ }).className).not.toMatch(/active/);
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
