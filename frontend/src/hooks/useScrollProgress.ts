import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * Scroll-driven progress for an element: 0 when its top edge reaches the
 * bottom of the viewport, 1 once its bottom edge passes a `startLine` from the
 * top. Returned as a CSS custom property so the consumer animates with
 * `transform: scaleY(var(--track-progress))` rather than a JS-driven style
 * write on every frame.
 *
 * **It reports 1 — fully drawn — whenever it cannot animate.** Three cases,
 * all of which must resolve to the finished state rather than to 0:
 *
 * - `prefers-reduced-motion: reduce`. The whole point of the reduced-motion
 *   path is that nothing moves; a track stuck at 0 would hide the connector
 *   line entirely, which is information, not decoration.
 * - No `IntersectionObserver` / no `requestAnimationFrame`.
 * - Before the first measured frame, and after the element leaves the tracked
 *   band. A track that snapped back to 0 on scroll-up would re-hide a
 *   connection the reader has already passed.
 *
 * So the hook can only ever make the sequence *more* complete than the static
 * frame, never less. The unanimated render is the finished render.
 */
export function useScrollProgress<T extends HTMLElement = HTMLDivElement>(
  options: { startLine?: number; endLine?: number } = {},
) {
  // Fractions of the viewport height where the run begins and ends. The default
  // band (80% down to 25%) means the track has drawn itself by the time it is
  // properly in view, and has finished before it scrolls away.
  const { startLine = 0.8, endLine = 0.25 } = options;

  const ref = useRef<T | null>(null);
  const [progress, setProgress] = useState(1);

  const [canAnimate] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function" &&
      !(
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ),
  );

  useEffect(() => {
    if (!canAnimate) return;
    const element = ref.current;
    if (!element) return;

    let pending = false;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      const start = viewport * startLine;
      const end = viewport * endLine;
      const travelled = start - rect.top;
      const span = start - end;

      if (span <= 0) {
        setProgress(1);
        return;
      }
      // Clamp at both ends: below the band 0, above it 1. A tall track whose
      // bottom never reaches `end` must still complete, which is why the upper
      // clamp is on `rect.bottom` rather than on `rect.top`.
      if (rect.top >= start) setProgress(0);
      else if (rect.bottom <= end) setProgress(1);
      else setProgress(Math.min(1, Math.max(0, travelled / span)));
    };

    /* A boolean latch rather than an id handle. `frame = rAF(measure)` looks
       equivalent and is not: if the callback ever runs synchronously — a stubbed
       rAF in a test, or a future polyfill that flushes immediately — the
       callback's own `frame = 0` is overwritten by the assignment that has not
       happened yet, leaving a truthy handle that makes every later
       `schedule()` return early. The pipeline would then freeze at whatever
       progress it had reached. Latching a flag *before* requesting has no
       ordering hazard at all. */
    const schedule = () => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(() => {
        pending = false;
        measure();
      });
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      pending = false;
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [canAnimate, startLine, endLine]);

  return { ref, progress, style: { "--track-progress": progress } as CSSProperties };
}
