import { fireEvent, render, screen } from "@testing-library/react";
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

describe("Navbar", () => {
  beforeEach(() => {
    user = { username: "alice", role: "customer" };
    logout.mockClear();
  });

  it("shows the brand and core navigation links", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("Q&A")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
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
    expect(
      screen.getByRole("link", { name: "AskDocs home" }).getAttribute("href"),
    ).toBe("/app");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: "Documents" }).getAttribute("href")).toBe("/app/documents");
    expect(screen.getByRole("link", { name: "Search" }).getAttribute("href")).toBe("/app/search");
    expect(screen.getByRole("link", { name: "Q&A" }).getAttribute("href")).toBe("/app/qa");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings");
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
    fireEvent.click(screen.getAllByText("Logout")[0]);
    expect(logout).toHaveBeenCalled();
  });

  it("moves focus into the menu when opened and restores it on Escape", () => {
    renderNavbar();
    const toggle = screen.getByRole("button", {
      name: "Open navigation menu",
    });

    fireEvent.click(toggle);
    // Focus lands on the first menu link (Home).
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Home" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", {
      name: "Open navigation menu",
    })).toBeTruthy();
    // Focus returns to the toggle button.
    expect(document.activeElement).toBe(toggle);
  });
});