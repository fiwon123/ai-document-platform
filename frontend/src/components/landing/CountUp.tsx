import { useEffect, useRef, useState } from "react";

type CountUpProps = {
  value: number;
  /** Duration of the animation in milliseconds (default 2000). */
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
export function CountUp({ value, durationMs = 2000, suffix = "", format }: CountUpProps) {
  // Whether to animate at all, decided once per mount.
  //
  // It has to be frozen: re-testing on every render would restart the
  // animation each time the parent re-rendered, and the decision cannot
  // change mid-flight anyway (the media query and the API are both stable
  // for the life of the page). A lazy state initializer runs exactly once,
  // unlike a ref, whose `.current` must not be read during render.
  //
  // When it is false the component renders `value` directly and never touches
  // animation state at all. The previous version instead set the final value
  // *and* flipped `started` from the same effect, so the animation effect
  // immediately overwrote it and counted up anyway — the opposite of what
  // "reduced motion" is supposed to do.
  const [canAnimate] = useState(
    () => typeof IntersectionObserver !== "undefined" && !prefersReducedMotion(),
  );

  const [display, setDisplay] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!canAnimate) return;
    const element = ref.current;
    if (!element) return;

    // setStarted is called from the observer callback rather than the effect
    // body: the callback is the external system telling us the element became
    // visible, which is exactly what an effect is for. A synchronous setState
    // in the effect body would just schedule a second render.
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
  }, [canAnimate]);

  useEffect(() => {
    if (!canAnimate || !started) return;
    const startTime = Date.now();
    const timer = window.setInterval(() => {
      const progress = Math.min((Date.now() - startTime) / durationMs, 1);
      // easeInOutCubic — accelerate in, decelerate out.
      //
      // This was easeOutCubic ("fast start, gentle landing"), which front-loads
      // ~66% of the value into the first 30% of the duration: 12,000 appeared to
      // leap to 8,000 almost immediately and then crawl, so the figure read as
      // a value being *revealed* rather than counted. Symmetric easing spends
      // the middle of the run at a legible rate, which is what makes a number
      // look like it is counting rather than snapping.
      const eased =
        progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      setDisplay(Math.round(value * eased));
      if (progress >= 1) {
        window.clearInterval(timer);
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [canAnimate, started, value, durationMs]);

  const current = canAnimate ? display : value;
  const shown = format ? format(current) : current.toLocaleString();

  // Drives the decorative "alive" styling (shake, grow, grey-to-ink colour
  // shift) in App.css. Deliberately derived rather than stored in its own
  // state: `display` is already the single source of truth for how far the
  // count has progressed, and a parallel `isAnimating` flag could drift out of
  // sync with it — e.g. stay true if the interval were cleared early.
  //
  // The class must stay off for the non-animating fallbacks (no
  // IntersectionObserver, reduced motion), since those render the final value
  // immediately and there is no count in progress to decorate.
  const animating = canAnimate && started && display < value;

  return (
    <span ref={ref} className={animating ? "count-up animating" : "count-up"}>
      {shown}
      {suffix}
    </span>
  );
}