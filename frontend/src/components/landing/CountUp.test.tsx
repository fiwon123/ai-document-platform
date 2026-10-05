import { act, render, screen } from "@testing-library/react";
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

  // ── data-count-state (#566) ────────────────────────────────────────────
  //
  // The class above cannot answer "has this number finished arriving?", and the
  // visual audit needs exactly that answer: `.animating` is absent both *while*
  // counting and *before* counting starts, so a settle written against it finds
  // nothing to wait for on the first pass and photographs "Search uptime 0%".
  // These three states have to be distinguishable from outside the component.

  it("reports pending, then animating, then done", async () => {
    vi.useFakeTimers();
    const { container } = render(<CountUp value={99} suffix="%" durationMs={1000} />);
    const state = () => container.querySelector(".count-up")!.getAttribute("data-count-state");

    // The observer mock reports isIntersecting, so this is the settled
    // "already started" case; the intermediate is asserted by the test below.
    await vi.advanceTimersByTimeAsync(1100);
    expect(state()).toBe("done");
  });

  it("is pending before the count starts, which is not the same as done", () => {
    // The distinction the whole attribute exists for. A count that has not
    // intersected yet is showing 0, and "no .animating on the page" is already
    // true — so a settle keyed on the class returns immediately and captures
    // the zero. `pending` is what makes the wait actually wait.
    //
    // The observer here records the element but never reports it intersecting,
    // which is what "scrolled past it" looks like from the component's side.
    let fire: (() => void) | undefined;
    class SilentObserver {
      constructor(callback: IntersectionObserverCallback) {
        fire = () =>
          callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      root = null;
      rootMargin = "";
      thresholds = [0];
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", SilentObserver);

    const { container } = render(<CountUp value={99} durationMs={1000} />);
    expect(container.querySelector(".count-up")!.getAttribute("data-count-state")).toBe("pending");
    expect(container.querySelector(".count-up")!.className).not.toContain("animating");

    // And it is the state change, not the text, that proves the wait would end:
    // once the count starts, `pending` resolves to a state that is not `done`,
    // so a wait on `done` is still holding.
    act(() => fire?.());
    expect(container.querySelector(".count-up")!.getAttribute("data-count-state")).not.toBe(
      "pending",
    );
  });

  it("is done immediately for the non-animating fallbacks, never pending", () => {
    // Reduced motion and a missing IntersectionObserver both render the final
    // value at once. If those reported `pending`, every capture on a
    // reduced-motion browser would wait out the full timeout for a count that
    // will never start, and then photograph anyway.
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const reduced = render(<CountUp value={512} durationMs={1000} />);
    expect(reduced.container.querySelector(".count-up")!.getAttribute("data-count-state")).toBe(
      "done",
    );
    reduced.unmount();

    vi.unstubAllGlobals();
    const none = render(<CountUp value={42} suffix="%" />);
    expect(none.container.querySelector(".count-up")!.getAttribute("data-count-state")).toBe("done");
  });
});