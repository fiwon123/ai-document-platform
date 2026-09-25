import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows a product-screenshot carousel in the hero", () => {
    renderPage();
    const carousel = screen.getByRole("group", {
      name: "AskDocs product screenshots",
    });
    expect(carousel).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Go to slide 1")).toBeTruthy();
  });

  it("shows social proof: logos, stats, and trust badges", () => {
    renderPage();
    expect(screen.getByText("Trusted by teams who ship")).toBeTruthy();
    expect(screen.getByText("Northwind")).toBeTruthy();
    expect(screen.getByText("Documents processed")).toBeTruthy();
    expect(screen.getByText("Questions answered")).toBeTruthy();
    expect(screen.getByText("Search uptime")).toBeTruthy();
    expect(screen.getByText("SOC 2 ready")).toBeTruthy();
    expect(screen.getByText("GDPR compliant")).toBeTruthy();
  });

  it("extended features list (8 cards) renders with icons", () => {
    renderPage();
    // Feature cards AND comparison-table rows share several names, so these
    // assertions include both occurrences.
    expect(screen.getAllByText("Bulk upload").length).toBeGreaterThan(0);
    expect(screen.getByText("Export results")).toBeTruthy();
    expect(screen.getAllByText("Webhook notifications").length).toBeGreaterThan(0);
    expect(screen.getByText("Blazing fast")).toBeTruthy();
  });

  it("switches plan card pricing between monthly and annual", () => {
    renderPage();
    expect(screen.getAllByText(/per month/).length).toBeGreaterThan(0);
    expect(screen.getByText("$12")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Toggle annual billing"));
    expect(screen.getByText("$10")).toBeTruthy();
    expect(screen.getByText("Save 17%")).toBeTruthy();
  });

  it("expands and collapses FAQ answers", () => {
    renderPage();
    const button = screen.getByRole("button", { name: /Is there a free plan/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a full footer with navigation, newsletter, and social links", () => {
    renderPage();
    expect(screen.getByText("Stay in the loop")).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Product" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Company" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeTruthy();
    expect(screen.getByLabelText("AskDocs on GitHub")).toBeTruthy();
    expect(screen.getByText("Made for people who love their documents.")).toBeTruthy();
  });
});