import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";

const toggleTheme = vi.fn();
let currentTheme: "light" | "dark" = "light";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ theme: currentTheme, toggleTheme }),
}));

describe("ThemeToggle", () => {
  beforeEach(() => {
    currentTheme = "light";
    toggleTheme.mockClear();
  });

  it("shows the moon icon in light mode (target: dark)", () => {
    render(<ThemeToggle />);
    // The moon path defines the "switch to dark" affinity.
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
    expect(document.querySelector("svg path")).toBeTruthy();
  });

  it("shows the sun icon in dark mode (target: light)", () => {
    currentTheme = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
    // Sun icon renders a circle as its first shape.
    expect(document.querySelector("svg circle")).toBeTruthy();
  });

  it("toggles the theme on click", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("still toggles when currently in dark mode", () => {
    currentTheme = "dark";
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
  });
});
