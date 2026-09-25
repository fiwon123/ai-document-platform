import { useEffect, useRef, useState } from "react";

type CountUpProps = {
  value: number;
  /** Duration of the animation in milliseconds (default 1200). */
  durationMs?: number;
  suffix?: string;
  /** Optional formatter; defaults to locale grouping (e.g. 12 400 → "12,400"). */
  format?: (value: number) => string;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Animated number that counts up from 0 when it scrolls into view. Falls
 *  back to showing the final value immediately when IntersectionObserver is
 *  unavailable (jsdom, old browsers) or reduced motion is requested. */
export function CountUp({ value, durationMs = 1200, suffix = "", format }: CountUpProps) {
  const [display, setDisplay] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (
      typeof IntersectionObserver === "undefined" ||
      prefersReducedMotion()
    ) {
      // No observer (jsdom, old browsers) or reduced motion: show the final
      // value immediately instead of animating.
      setStarted(true);
      setDisplay(value);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      const progress = Math.min((Date.now() - startTime) / durationMs, 1);
      // easeOutCubic — fast start, gentle landing.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * eased));
      if (progress >= 1) {
        window.clearInterval(timer);
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [started, value, durationMs]);

  const shown = format ? format(display) : display.toLocaleString();

  return (
    <span ref={ref} className="count-up">
      {shown}
      {suffix}
    </span>
  );
}