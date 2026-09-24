import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user }),
}));

let user: { username: string; role: string } | null;

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  user = null;
});

describe("LandingPage", () => {
  it("renders hero, features, how-it-works, pricing, and footer sections", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Find and ask anything",
    );
    expect(screen.getByText("Upload anything")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pricing that grows with you" })).toBeTruthy();
    expect(screen.getByText("Compare plans")).toBeTruthy();
    expect(screen.getByText("AI Document Intelligence Platform")).toBeTruthy();
  });

  it("offers demo and registration CTAs to anonymous visitors", () => {
    renderPage();
    expect(screen.getAllByRole("link", { name: "Try the live demo" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Create free account" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("No credit card required. Try it without an account.").length).toBeGreaterThan(0);
  });

  it("lists three plans with differing limits", () => {
    renderPage();
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Enterprise").length).toBeGreaterThan(0);
    // Comparison table shows a free-tier limitation vs pro unlimited
    expect(screen.getByText("10 / month")).toBeTruthy();
    expect(screen.getAllByText("Unlimited").length).toBeGreaterThan(0);
  });

  it("points signed-in visitors to their workspace instead of sign-up", () => {
    user = { username: "alice", role: "customer" };
    renderPage();
    expect(screen.queryByText("Create free account")).toBeNull();
    const workspaceLinks = screen.getAllByRole("link", { name: "Go to your workspace" });
    expect(workspaceLinks.length).toBeGreaterThan(0);
    workspaceLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app");
    });
    expect(screen.getAllByText("Open workspace").length).toBeGreaterThan(0);
    expect(screen.queryByText("No credit card required. Try it without an account.")).toBeNull();
  });
});