import type { CSSProperties, ReactNode } from "react";
import { useScrollReveal } from "../hooks/useScrollReveal";

type RevealTag =
  | "div"
  | "section"
  | "article"
  | "li"
  | "header"
  | "footer"
  | "span"
  | "p";

interface RevealProps {
  /** Element type to render. Defaults to div. */
  as?: RevealTag;
  /** Direction variant: fade-rise (default), slide in from the left/right,
   * or a subtle scale-up. */
  variant?: "up" | "left" | "right" | "scale";
  /** Stagger delay in ms — sets --reveal-delay for lists/grids. */
  delay?: number;
  /** Extra classes appended after the reveal classes. */
  className?: string;
  children: ReactNode;
}

const VARIANT_CLASS: Record<NonNullable<RevealProps["variant"]>, string> = {
  up: "reveal",
  left: "reveal reveal-left",
  right: "reveal reveal-right",
  scale: "reveal reveal-scale",
};

/**
 * Scroll-triggered reveal wrapper (IntersectionObserver via useScrollReveal).
 * Content fades/rises the first time it enters the viewport. Content is never
 * permanently hidden: reduced motion and browsers without IntersectionObserver
 * get the element visible immediately.
 */
export function Reveal({
  as: Tag = "div",
  variant = "up",
  delay = 0,
  className = "",
  children,
}: RevealProps) {
  const { ref, isVisible } = useScrollReveal<HTMLElement>();
  const style: CSSProperties | undefined =
    delay > 0
      ? ({ "--reveal-delay": `${delay}ms` } as CSSProperties)
      : undefined;

  return (
    <Tag
      ref={ref as never}
      className={`${VARIANT_CLASS[variant]}${isVisible ? " is-revealed" : ""}${
        className ? ` ${className}` : ""
      }`}
      style={style}
    >
      {children}
    </Tag>
  );
}