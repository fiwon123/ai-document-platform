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
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (typeof IntersectionObserver !== "function" || prefersReducedMotion) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return { ref, isVisible };
}