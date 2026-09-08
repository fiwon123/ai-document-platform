import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { LandingNavbar } from "./LandingNavbar";

function renderNavbar() {
  return render(
    <MemoryRouter>
      <LandingNavbar />
    </MemoryRouter>,
  );
}

describe("LandingNavbar", () => {
  it("shows the brand and marketing links", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByText("Features")).toBeTruthy();
    expect(screen.getByText("How it works")).toBeTruthy();
    expect(screen.getByText("Pricing")).toBeTruthy();
  });

  it("links to demo, login, and sign up", () => {
    renderNavbar();
    expect(screen.getByRole("link", { name: "Try the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
    expect(screen.getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      "/login",
    );
  });
});