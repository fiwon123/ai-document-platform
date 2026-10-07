import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Navbar } from "./Navbar";

const logout = vi.fn();

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user, logout }),
}));

let user: { username: string; role: string } | null;

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/**
 * App.css with comments stripped — a comment quoting a selector would otherwise
 * satisfy a guard that is only looking for the text.
 */
const css = readFileSync(resolve(__dirname, "../App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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

describe("Navbar", () => {
  beforeEach(() => {
    user = { username: "alice", role: "customer" };
    logout.mockClear();
  });

  it("shows the brand, workspace badge and core navigation links", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Back to site")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("Q&A")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  /* The workspace navigation used to carry no auto margin of its own while
     `.navbar-user` carried `margin-left: auto`, so every pixel of the row's free
     space went to one side and the six page links sat packed against the brand.
     The free space is now split either side of the links instead. These pin the
     CSS that does it, because "the links are in the middle" is not something a
     jsdom assertion about the DOM can see. */
  it("centres the page links by splitting the row's free space either side", () => {
    const decls = declarationsFor(".navbar-links");
    expect(decls, "links must split the free space on both sides").toContain("margin-inline: auto");
  });

  it("does not push the user cluster with a one-sided auto margin", () => {
    // Both sides auto on `.navbar-links` is what centres the group; a
    // `margin-left: auto` here as well would add a third auto margin, and flexbox
    // would split the free space three ways — the links would drift off centre
    // again by however much the cluster is wider than the brand.
    expect(declarationsFor(".navbar-user")).not.toContain("margin-left: auto");
  });

  it("keeps the page links in their own row, ahead of the user cluster", () => {
    const { container } = renderNavbar();
    // Source order is the reading and Tab order, so the links must precede the
    // cluster that holds the theme toggle, username and logout.
    const nav = container.querySelector(".navbar")!;
    const children = [...nav.children].map((el) => el.className.split(" ")[0]);
    expect(children.indexOf("navbar-links")).toBeLessThan(children.indexOf("navbar-user"));
  });

  it("renders the AskDocs brand mark next to the name", () => {
    const { container } = renderNavbar();
    expect(container.querySelector(".navbar-brand-mark")).toBeTruthy();
    expect(container.querySelector(".navbar-brand a span")?.textContent).toBe("AskDocs");
  });

  it("only renders the Users link for admins", () => {
    renderNavbar();
    expect(screen.queryByText("Users")).toBeNull();

    user = { username: "admin", role: "admin" };
    renderNavbar();
    expect(screen.getAllByText("Users").length).toBeGreaterThan(0);
  });

  it("links all app navigation to /app-prefixed routes", () => {
    renderNavbar();
    expect(screen.getByRole("link", { name: "AskDocs home" }).getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: "Back to site" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: "Documents" }).getAttribute("href")).toBe(
      "/app/documents",
    );
    expect(screen.getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/app/search");
    expect(screen.getByRole("link", { name: "Q&A" }).getAttribute("href")).toBe("/app/qa");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/app/settings",
    );
  });

  it("links the admin and profile areas under /app", () => {
    user = { username: "admin", role: "admin" };
    renderNavbar();
    expect(screen.getByRole("link", { name: "Users" }).getAttribute("href")).toBe("/app/admin");
    const profileLinks = screen.getAllByRole("link", { name: "admin" });
    expect(profileLinks.length).toBeGreaterThan(0);
    profileLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app/profile");
    });
  });

  it("logs out and navigates to login", () => {
    renderNavbar();
    fireEvent.click(screen.getAllByText("Logout")[0]!);
    expect(logout).toHaveBeenCalled();
  });

  it("moves focus into the menu when opened and restores it on Escape", () => {
    renderNavbar();
    const toggle = screen.getByRole("button", {
      name: "Open navigation menu",
    });

    fireEvent.click(toggle);
    // Focus lands on the first link *inside the menu*. The back link is no
    // longer a menu item — it sits beside the brand, always visible — so
    // "Dashboard" is now the first focusable thing the disclosure reveals.
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Dashboard" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("button", {
        name: "Open navigation menu",
      }),
    ).toBeTruthy();
    // Focus returns to the toggle button.
    expect(document.activeElement).toBe(toggle);
  });

  it("marks the active route link with aria-current", () => {
    render(
      <MemoryRouter initialEntries={["/app/documents"]}>
        <Navbar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Documents" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Back to site" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("styles the back link as an exit link (never active, arrow included)", () => {
    const { container } = renderNavbar();
    const backLink = screen.getByRole("link", { name: "Back to site" });
    expect(backLink.className).toContain("navbar-back-link");
    // The arrow icon renders inside the link.
    expect(backLink.querySelector("svg")).toBeTruthy();
    // It is a sibling immediately *before* the brand block, not inside it and
    // not part of the page-link row.
    const brand = container.querySelector(".navbar-brand")!;
    expect(brand.contains(backLink)).toBe(false);
    expect(backLink.nextElementSibling).toBe(brand);
    expect(container.querySelector(".navbar-links")!.contains(backLink)).toBe(false);
  });

  it("keeps the back link accessible by name when the label is visually hidden", () => {
    // On <=768px the text is clipped with clip-path rather than removed, so
    // it stays in the accessibility tree and the link keeps its name.
    renderNavbar();
    const backLink = screen.getByRole("link", { name: "Back to site" });
    expect(backLink.querySelector(".navbar-back-link-text")?.textContent).toBe("Back to site");
    // No aria-label overriding the visible text (voice-control label match).
    expect(backLink.getAttribute("aria-label")).toBeNull();
  });

  it("marks the dashboard link active on the /app index", () => {
    render(
      <MemoryRouter initialEntries={["/app"]}>
        <Navbar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Documents" }).getAttribute("aria-current")).toBeNull();
  });
});
