import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reveal } from "./Reveal";

type IOEntry = { isIntersecting: boolean };

let currentCallback: ((entries: IOEntry[]) => void) | null = null;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

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

describe("Reveal", () => {
  beforeEach(() => {
    currentCallback = null;
    mockObserve.mockClear();
    mockDisconnect.mockClear();
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders children hidden until the element intersects", () => {
    render(
      <Reveal>
        <p>revealed content</p>
      </Reveal>,
    );

    const target = screen.getByText("revealed content").closest(".reveal");
    expect(target).not.toBeNull();
    expect(target?.className).toContain("reveal");
    expect(target?.className).not.toContain("is-revealed");

    act(() => {
      currentCallback?.([{ isIntersecting: true }]);
    });

    expect(target?.className).toContain("is-revealed");
  });

  it("applies the variant class for directional reveals", () => {
    render(
      <Reveal variant="left">
        <p>slide in</p>
      </Reveal>,
    );

    const target = screen.getByText("slide in").closest(".reveal");
    expect(target?.className).toContain("reveal-left");
  });

  it("sets the stagger delay as a CSS custom property", () => {
    render(
      <Reveal delay={120}>
        <p>delayed</p>
      </Reveal>,
    );

    const target = screen.getByText("delayed").closest(".reveal") as HTMLElement;
    expect(target.style.getPropertyValue("--reveal-delay")).toBe("120ms");
  });

  it("renders the requested element type", () => {
    render(
      <Reveal as="section">
        <p>section reveal</p>
      </Reveal>,
    );

    const section = screen.getByText("section reveal").closest("section");
    expect(section?.className).toContain("reveal");
  });

  it("appends extra classes", () => {
    render(
      <Reveal className="card-hover">
        <p>card</p>
      </Reveal>,
    );

    const target = screen.getByText("card").closest(".reveal") as HTMLElement;
    expect(target.className).toContain("card-hover");
  });

  it("reveals immediately under prefers-reduced-motion", () => {
    stubMatchMedia(true);

    render(
      <Reveal>
        <p>instant</p>
      </Reveal>,
    );

    const target = screen.getByText("instant").closest(".reveal");
    expect(target?.className).toContain("is-revealed");
    expect(mockObserve).not.toHaveBeenCalled();
  });
});
