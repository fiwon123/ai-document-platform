import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandingNavbar } from "./LandingNavbar";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user }),
}));

let user: { username: string; role: string } | null;

function renderNavbar() {
  return render(
    <MemoryRouter>
      <LandingNavbar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  user = null;
});

describe("LandingNavbar", () => {
  it("shows the brand and marketing links", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByText("Features")).toBeTruthy();
    expect(screen.getByText("How it works")).toBeTruthy();
    expect(screen.getByText("Pricing")).toBeTruthy();
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