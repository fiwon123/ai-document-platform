import { useEffect, useRef, useState } from "react";

export interface ScrollRevealOptions {
  /** Fraction of the element that must be visible before revealing (0–1). */
  threshold?: number;
  /** Viewport root margin, e.g. "0px 0px -10% 0px" reveals just before the
   * element fully enters. */
  rootMargin?: string;
}

/**
 * Reveal-on-scroll: observes the returned ref and flips `isVisible` the first
 * time the element intersects the viewport, then disconnects. No-ops straight
 * to *visible* when IntersectionObserver is unavailable or the user prefers
 * reduced motion, so content is never permanently hidden — the CSS reveal
 * classes only animate when `is-revealed` is actually applied.
 */
export function useScrollReveal<T extends HTMLElement = HTMLDivElement>(
  options: ScrollRevealOptions = {},
) {
  const { threshold = 0.15, rootMargin = "0px 0px -10% 0px" } = options;
  const ref = useRef<T | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Whether a reveal animation is possible at all, decided once per mount.
  // When it is not, the content is simply reported as visible and no observer
  // is created — rather than flipping state from the effect body, which the
  // react(set-state-in-effect) rule flags because it schedules a redundant
  // second render on every mount. The lazy initializer runs once, and unlike a
  // ref it needs no `.current` read during render.
  const [canReveal] = useState(
    () =>
      typeof IntersectionObserver === "function" &&
      !(
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ),
  );

  useEffect(() => {
    if (!canReveal) return;
    const element = ref.current;
    if (!element) return;

    // setRevealed fires from the observer callback, i.e. from the external
    // system reporting that the element scrolled into view — the case effects
    // exist for. It is not a synchronous setState in the effect body.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [canReveal, threshold, rootMargin]);

  return { ref, isVisible: canReveal ? revealed : true };
}
