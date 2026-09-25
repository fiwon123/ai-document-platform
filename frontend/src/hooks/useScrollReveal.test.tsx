import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollReveal } from "./useScrollReveal";

type IOEntry = { isIntersecting: boolean };

let currentCallback: ((entries: IOEntry[]) => void) | null = null;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

/** Minimal IntersectionObserver stand-in capturing the callback so tests can
 * fire intersection entries manually (jsdom ships no IntersectionObserver). */
class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  constructor(callback: (entries: IOEntry[]) => void) {
    currentCallback = callback;
  }

  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);
}

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

function Harness() {
  const { ref, isVisible } = useScrollReveal<HTMLDivElement>();
  return (
    <div ref={ref} data-visible={isVisible}>
      content
    </div>
  );
}

describe("useScrollReveal", () => {
  beforeEach(() => {
    currentCallback = null;
    mockObserve.mockClear();
    mockDisconnect.mockClear();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    stubMatchMedia(false); // motion allowed by default
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts hidden and reveals when the element intersects the viewport", () => {
    const { container } = render(<Harness />);

    const target = container.firstElementChild as HTMLElement;
    expect(target.dataset.visible).toBe("false");
    expect(mockObserve).toHaveBeenCalledWith(target);

    act(() => {
      currentCallback?.([{ isIntersecting: true }]);
    });

    expect(target.dataset.visible).toBe("true");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("ignores non-intersecting observations", () => {
    const { container } = render(<Harness />);

    const target = container.firstElementChild as HTMLElement;
    act(() => {
      currentCallback?.([{ isIntersecting: false }]);
    });

    expect(target.dataset.visible).toBe("false");
  });

  it("reveals immediately when IntersectionObserver is unavailable", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);

    const { container } = render(<Harness />);

    const target = container.firstElementChild as HTMLElement;
    expect(target.dataset.visible).toBe("true");
  });

  it("reveals immediately when the user prefers reduced motion", () => {
    stubMatchMedia(true);

    const { container } = render(<Harness />);

    const target = container.firstElementChild as HTMLElement;
    expect(target.dataset.visible).toBe("true");
    expect(mockObserve).not.toHaveBeenCalled();
  });
});