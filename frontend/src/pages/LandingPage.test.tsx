import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

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

  it("offers demo and registration CTAs", () => {
    renderPage();
    expect(screen.getAllByRole("link", { name: "Try the live demo" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Create free account" }).length).toBeGreaterThan(0);
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
});