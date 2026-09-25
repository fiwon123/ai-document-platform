import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("shows the brand and the two section menus", () => {
    renderNavbar();
    expect(screen.getByText("AskDocs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Product/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Company/ })).toBeTruthy();
  });

  it("keeps child pages hidden until a menu is opened", async () => {
    renderNavbar();
    // The old flat links were always visible. They now live behind the menus, so
    // nothing is on screen that the visitor did not ask for.
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

  it("reports open state through aria-expanded", async () => {
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Product/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderNavbar();
    const trigger = screen.getByRole("button", { name: /Product/ });
    await userEvent.click(trigger);
    expect(screen.queryByRole("link", { name: "Features" })).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
    // Focus must come back, or Escape strands the user at the top of the page.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a click lands outside the menu", async () => {
    renderNavbar();
    await userEvent.click(screen.getByRole("button", { name: /Product/ }));
    expect(screen.queryByRole("link", { name: "Features" })).not.toBeNull();

    await userEvent.click(screen.getByText("AskDocs"));
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
  });

  it("keeps legal pages out of the header", async () => {
    renderNavbar();
    for (const label of [/Product/, /Company/]) {
      await userEvent.click(screen.getByRole("button", { name: label }));
    }
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
