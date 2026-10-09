import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollToTop } from "./useScrollToTop";

const scrollTo = vi.fn();

/** The hook plus a `navigate`, so a path change can be driven from the test. */
function useProbe() {
  useScrollToTop();
  return useNavigate();
}

function render(path: string) {
  return renderHook(() => useProbe(), {
    wrapper: ({ children }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
  });
}

beforeEach(() => {
  scrollTo.mockClear();
  // jsdom's `window.scrollTo` is "not implemented" — replace it so the effect's
  // call is observable instead of logging a warning.
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScrollToTop", () => {
  it("scrolls to the top on a marketing route", () => {
    render("/pricing");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls to the top on a nested marketing route", () => {
    render("/challenges/new");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("does not scroll on an app route", () => {
    render("/app");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls when navigating between marketing routes", () => {
    const { result } = render("/");
    scrollTo.mockClear();
    act(() => {
      result.current("/features");
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
