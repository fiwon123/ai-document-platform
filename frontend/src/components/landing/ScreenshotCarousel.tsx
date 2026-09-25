import { useCallback, useEffect, useRef, useState } from "react";

export type CarouselSlide = {
  /** Image path served from /public (e.g. "/screenshots/dashboard.png"). */
  src: string;
  alt: string;
  caption?: string;
};

type ScreenshotCarouselProps = {
  slides: CarouselSlide[];
  /** Auto-advance interval in milliseconds (default 5s). */
  intervalMs?: number;
  /** Accessible name for the carousel region. */
  label?: string;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Crossfading product-screenshot carousel with dot navigation, arrow
 *  controls, auto-advance and pause-on-hover/focus. Stops auto-advancing for
 *  reduced-motion users and single-slide sets. */
export function ScreenshotCarousel({
  slides,
  intervalMs = 5_000,
  label = "Product screenshots",
}: ScreenshotCarouselProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<number | null>(null);

  const goTo = useCallback(
    (next: number) => {
      const length = slides.length;
      if (length === 0) return;
      setIndex(((next % length) + length) % length);
    },
    [slides.length],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (paused || prefersReducedMotion() || slides.length < 2) return;
    clearTimer();
    timerRef.current = window.setInterval(
      () => setIndex((current) => (current + 1) % slides.length),
      intervalMs,
    );
    return clearTimer;
  }, [paused, intervalMs, slides.length, clearTimer]);

  if (slides.length === 0) {
    return null;
  }

  return (
    <div
      className="screenshot-carousel"
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="carousel-slides" style={{ aspectRatio: "16 / 10" }}>
        {slides.map((slide, i) => (
          <figure
            key={slide.src}
            className={`carousel-slide${i === index ? " active" : ""}`}
            aria-hidden={i !== index}
          >
            <img src={slide.src} alt={slide.alt} loading="lazy" />
            {slide.caption && (
              <figcaption className="carousel-caption">{slide.caption}</figcaption>
            )}
          </figure>
        ))}
      </div>

      {slides.length > 1 && (
        <>
          <span className="carousel-count" aria-hidden="true">
            {index + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="carousel-arrow carousel-arrow-prev"
            aria-label="Previous screenshot"
            onClick={() => goTo(index - 1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path d="M15 4l-8 8 8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="carousel-arrow carousel-arrow-next"
            aria-label="Next screenshot"
            onClick={() => goTo(index + 1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="carousel-dots" role="tablist" aria-label="Choose screenshot">
            {slides.map((slide, i) => (
              <button
                key={slide.src}
                type="button"
                className={`carousel-dot${i === index ? " active" : ""}`}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => goTo(i)}
              >
                <span />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}