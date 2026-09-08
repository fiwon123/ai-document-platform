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
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.getByText("Q&A")).toBeTruthy();
  });

  it("only renders the Users link for admins", () => {
    renderNavbar();
    expect(screen.queryByText("Users")).toBeNull();

    user = { username: "admin", role: "admin" };
    renderNavbar();
    expect(screen.getAllByText("Users").length).toBeGreaterThan(0);
  });

  it("logs out and navigates to login", () => {
    renderNavbar();
    fireEvent.click(screen.getAllByText("Logout")[0]);
    expect(logout).toHaveBeenCalled();
  });
});