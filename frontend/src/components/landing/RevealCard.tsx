import type { CSSProperties, ReactNode } from "react";
import { useScrollReveal } from "../../hooks/useScrollReveal";

interface RevealCardProps {
  /** Stagger delay in ms — sets --reveal-delay. */
  delay?: number;
  /** Extra classes appended after `reveal-card`. */
  className?: string;
  /** Per-card accent key, forwarded as `data-accent` for the themed washes. */
  accent?: string;
  children: ReactNode;
}

/**
 * A feature card that reveals on scroll **without adding a wrapper element**.
 *
 * `Reveal` renders a box around its children, and that box is what broke these
 * grids: the card grids lay their cards out with CSS grid, and grid items
 * stretch to the tallest in their row — but a card inside an `inline-flex`
 * wrapper sizes to its own content, so the row's bottom edge stepped down by
 * the height difference (24px, measured). The obvious fix is to put the reveal
 * class on the card itself, which is what this does.
 *
 * The reason it is a component rather than a `className="reveal-card"` on the
 * card in `LandingPage` is that `is-revealed` is applied by JavaScript, not by
 * CSS. `useScrollReveal` is what flips it, and the only code that called it
 * here was `Reveal` itself — so moving the class by hand left the cards at
 * `opacity: 0` permanently, for every visitor who does not prefer reduced
 * motion. The cards were simply not on the page.
 *
 * `will-change` is deliberately not set here (unlike `.reveal`): these cards
 * stay on screen for the whole session, so promoting each to its own compositor
 * layer costs memory for no benefit.
 */
export function RevealCard({ delay = 0, className = "", accent, children }: RevealCardProps) {
  const { ref, isVisible } = useScrollReveal<HTMLElement>();
  const style: CSSProperties | undefined =
    delay > 0 ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties) : undefined;

  return (
    <article
      ref={ref as never}
      className={`reveal-card${isVisible ? " is-revealed" : ""}${className ? ` ${className}` : ""}`}
      data-accent={accent}
      style={style}
    >
      {children}
    </article>
  );
}
