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

  it("never animates under reduced motion, even though the observer fires", async () => {
    // Regression guard. The observer mock above reports isIntersecting
    // immediately, so the old code set both the final value and `started` from
    // the same effect — the animation effect then took over and counted up
    // from 0, which is precisely what a visitor who asked for reduced motion
    // does not want. The value must stay pinned at the target for the whole
    // animation window, not just on first paint.
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    render(<CountUp value={512} durationMs={1000} />);

    expect(screen.getByText("512")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.getByText("512")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(600);
    expect(screen.getByText("512")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("applies a custom formatter", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }),
    );
    render(<CountUp value={1200} format={(n) => `${n}k`} />);
    expect(screen.getByText("1200k")).toBeTruthy();
  });

  it("marks the number as animating only while the count is in progress", async () => {
    // The class is the CSS hook for the shake / grow / grey-to-ink ramp in
    // App.css. It must be present for the whole count and dropped on the frame
    // the final value lands, otherwise the number keeps shaking forever or
    // never animates at all.
    vi.useFakeTimers();
    const { container } = render(<CountUp value={12000} durationMs={1000} />);
    const el = container.querySelector(".count-up")!;

    expect(el.className).toContain("animating");

    await vi.advanceTimersByTimeAsync(500);
    expect(container.querySelector(".count-up")!.className).toContain(
      "animating",
    );

    await vi.advanceTimersByTimeAsync(600);
    const done = container.querySelector(".count-up")!;
    expect(done.className).not.toContain("animating");
    expect(done.textContent).toBe("12,000");
  });

  it("never marks the number as animating for reduced motion", async () => {
    // Reduced motion renders the final value instantly, so there is no count
    // in progress to decorate. A lingering .animating would shake a number
    // that a visitor explicitly asked not to animate.
    //
    // The observer mock still reports isIntersecting immediately, so this does
    // prove the guard rather than passing by accident: `canAnimate` being
    // false is what must keep the class off, not the fact that the count
    // happens to be finished.
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const { container } = render(<CountUp value={512} durationMs={1000} />);
    const el = container.querySelector(".count-up")!;
    expect(el.className).not.toContain("animating");
    expect(el.textContent).toBe("512");
    await vi.advanceTimersByTimeAsync(1200);
    expect(container.querySelector(".count-up")!.className).not.toContain(
      "animating",
    );
  });

  it("never marks the number as animating without IntersectionObserver", () => {
    vi.unstubAllGlobals();
    const { container } = render(<CountUp value={42} suffix="%" />);
    const el = container.querySelector(".count-up")!;
    expect(el.className).not.toContain("animating");
    expect(el.textContent).toBe("42%");
  });
});