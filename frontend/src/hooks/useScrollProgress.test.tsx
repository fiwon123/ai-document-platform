import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollProgress } from "./useScrollProgress";

/**
 * `useScrollProgress` drives the pipeline rail's `scaleY()`.
 *
 * The invariant this file exists to protect is one-directional and easy to break
 * by accident: **the hook may only ever make the sequence more complete than
 * the static frame, never less.** A connector line that reads 0 under reduced
 * motion is not "less animated", it is a missing connection — the reader is
 * shown a pipeline whose stages are not joined, by the code path whose purpose
 * is to make the page more accessible.
 *
 * jsdom performs no layout, so `getBoundingClientRect()` returns zeros. Every
 * test stubs it; the arithmetic being verified is the clamping and the
 * degradation paths, both of which are pure functions of those stubs.
 */

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

/** Give the observed element a box, since jsdom always reports 0×0. */
function stubRect(element: HTMLElement, rect: Partial<DOMRect>) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

function Harness() {
  const { ref, progress, style } = useScrollProgress<HTMLDivElement>();
  return (
    <div ref={ref} style={style} data-testid="track" data-progress={progress} />
  );
}

/** The value the CSS custom property carries — what the rail actually renders. */
function reportedProgress(container: HTMLElement): string {
  return container.querySelector("[data-testid='track']")?.getAttribute("data-progress") ?? "";
}

let originalMatchMedia: unknown;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  Object.defineProperty(window, "innerHeight", { writable: true, value: 1000 });
});

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

describe("useScrollProgress", () => {
  it("reports fully drawn when the user prefers reduced motion", () => {
    stubMatchMedia(true);
    const { container } = render(<Harness />);
    expect(reportedProgress(container)).toBe("1");
  });

  it("reports fully drawn when requestAnimationFrame is unavailable", () => {
    stubMatchMedia(false);
    // Browsers without rAF are not a real case for this app, but the hook must
    // not throw or report 0 there — that is the failure this guards.
    Object.defineProperty(window, "requestAnimationFrame", {
      writable: true,
      value: undefined,
    });
    const { container } = render(<Harness />);
    expect(reportedProgress(container)).toBe("1");
  });

  it("reports fully drawn before any measurement can happen", () => {
    // The initial state must be the finished state, so the first paint of a
    // page that never scrolls is already correct.
    stubMatchMedia(false);
    const { container } = render(<Harness />);
    expect(reportedProgress(container)).toBe("1");
  });

  it("is 0 while the element is still below the band, and 1 once it has passed", () => {
    stubMatchMedia(false);

    const { container, rerender } = render(<Harness />);
    const track = container.querySelector("[data-testid='track']") as HTMLElement;

    // Default band is startLine 0.8 / endLine 0.25 of a 1000px viewport, so the
    // run is between y=800 (0) and y=250 (1) — 550px of travel.
    stubRect(track, { top: 900, bottom: 3000 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(reportedProgress(container)).toBe("0");

    stubRect(track, { top: 100, bottom: 2200 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(reportedProgress(container)).toBe("1");

    // Mid-run: half the band travelled.
    stubRect(track, { top: 525, bottom: 2625 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    const mid = Number(reportedProgress(container));
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);

    rerender(<Harness />);
  });

  it("completes a track taller than the band, using its bottom edge", () => {
    stubMatchMedia(false);
    const { container } = render(<Harness />);
    const track = container.querySelector("[data-testid='track']") as HTMLElement;

    // top is still inside the band, so a clamp on `top` alone would leave this
    // track permanently incomplete — a tall pipeline would stop drawing.
    stubRect(track, { top: 400, bottom: -9000 });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(reportedProgress(container)).toBe("1");
  });

  it("never reports outside 0..1", () => {
    stubMatchMedia(false);
    const { container } = render(<Harness />);
    const track = container.querySelector("[data-testid='track']") as HTMLElement;

    for (const rect of [
      { top: 5000, bottom: 9000 },
      { top: -5000, bottom: -100 },
      { top: -40, bottom: 60 },
    ]) {
      stubRect(track, rect);
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      const value = Number(reportedProgress(container));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("publishes the progress as a custom property for the rail", () => {
    stubMatchMedia(true);
    const { container } = render(<Harness />);
    const track = container.querySelector("[data-testid='track']") as HTMLElement;
    // The rail animates with `scaleY(var(--track-progress))`; the hook's job is
    // to set that variable and nothing else.
    expect(track.style.getPropertyValue("--track-progress")).toBe("1");
  });

  it("removes its scroll and resize listeners on unmount", () => {
    stubMatchMedia(false);
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness />);
    unmount();
    const events = remove.mock.calls.map(([event]) => event);
    expect(events).toContain("scroll");
    expect(events).toContain("resize");
  });
});
