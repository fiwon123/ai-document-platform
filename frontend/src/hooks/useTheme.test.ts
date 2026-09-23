import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    stubMatchMedia(false); // system prefers light by default
  });

  it("defaults to light when nothing is saved and the system prefers light", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("defaults to dark when the system prefers dark", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("prefers a saved light theme over the system preference", () => {
    stubMatchMedia(true);
    localStorage.setItem("askdocs-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("prefers a saved dark theme over the system preference", () => {
    stubMatchMedia(false);
    localStorage.setItem("askdocs-theme", "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("falls back to the system preference for an invalid saved value", () => {
    localStorage.setItem("askdocs-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("falls back to dark when the system prefers dark and the saved value is invalid", () => {
    stubMatchMedia(true);
    localStorage.setItem("askdocs-theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("toggles from light to dark", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("toggles from dark to light", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
  });

  it("persists the theme to localStorage on change", () => {
    const { result } = renderHook(() => useTheme());
    expect(localStorage.getItem("askdocs-theme")).toBe("light");
    act(() => result.current.toggleTheme());
    expect(localStorage.getItem("askdocs-theme")).toBe("dark");
    act(() => result.current.toggleTheme());
    expect(localStorage.getItem("askdocs-theme")).toBe("light");
  });

  it("syncs the theme to the document element dataset", () => {
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => result.current.toggleTheme());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});