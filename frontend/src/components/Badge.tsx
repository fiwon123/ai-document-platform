import type { ReactNode } from "react";

export type BadgeTone = "blue" | "green" | "amber" | "red" | "gray";

interface BadgeProps {
  /** Semantic color: green (ready/active), blue (processing), amber (pending),
   *  red (failed), gray (inactive/unknown/counts). */
  tone: BadgeTone;
  children: ReactNode;
  /** Renders a small leading status dot. */
  dot?: boolean;
  /** Native tooltip (e.g. elapsed time for a processing badge). */
  title?: string;
  className?: string;
}

/**
 * Tuned per `DocumentStatus` so pages can map a document status to a
 * consistent badge tone without repeating the mapping. See
 * `documentStatusTone.ts` for the mapping itself — it is kept out of this
 * file so `Badge.tsx` exports only a component, which keeps Fast Refresh
 * working while editing the badge.
 */

/**
 * Accessible status pill. Each tone pairs a 100-level tinted background with
 * a 700/800-level text color in light mode, and a soft tinted background with
 * a 300-level text color in dark mode — keeping WCAG AA contrast in both
 * themes without hardcoded hex values in pages (tone colors live in CSS
 * variables, see App.css).
 */
export function Badge({ tone, children, dot, title, className = "" }: BadgeProps) {
  return (
    <span
      className={`badge badge-${tone}${dot ? " badge-with-dot" : ""} ${className}`.trim()}
      title={title}
    >
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}