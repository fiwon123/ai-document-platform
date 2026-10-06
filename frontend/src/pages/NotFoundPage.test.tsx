import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NotFoundPage } from "./NotFoundPage";

describe("NotFoundPage", () => {
  it("shows the 404 code and the page-not-found copy", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
    expect(screen.getByText("Page not found")).toBeTruthy();
  });

  it("links back to the dashboard and home", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    const dashboard = screen.getByRole("link", { name: "Back to dashboard" });
    const home = screen.getByRole("link", { name: "Go home" });
    expect(dashboard.getAttribute("href")).toBe("/app");
    expect(home.getAttribute("href")).toBe("/");
  });
});
