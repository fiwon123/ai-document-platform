import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountUp } from "./CountUp";

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    IntersectionObserverMock.instances.push(this);
  }
  // Fire the callback synchronously so CountUp starts its animation
  // immediately (matches an element already in view).
  observe() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  root = null;
  rootMargin = "";
  thresholds = [0];
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  IntersectionObserverMock.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CountUp", () => {
  it("starts at zero and animates to the target value", async () => {
    vi.useFakeTimers();
    render(<CountUp value={12400} durationMs={1000} />);
    // The synchronous observer callback starts the animation; the first
    // tick renders 0 until time passes.
    expect(screen.getByText(/^0$/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1100);
    expect(screen.getByText("12,400")).toBeTruthy();
  });

  it("renders the final value instantly when IntersectionObserver is missing", () => {
    vi.unstubAllGlobals();
    render(<CountUp value={42} suffix="%" />);
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("renders the final value instantly for reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<CountUp value={512} />);
    expect(screen.getByText("512")).toBeTruthy();
  });

  it("applies a custom formatter", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }),
    );
    render(<CountUp value={1200} format={(n) => `${n}k`} />);
    expect(screen.getByText("1200k")).toBeTruthy();
  });
});