interface MatchChipProps {
  /**
   * Semantic similarity as a percentage (0–100). Callers convert the
   * backend cosine distance (`(1 - distance) * 100`, real search) or pass a
   * fake relevance (demo) — the chip only cares about the percent.
   */
  pct: number;
}

/**
 * Colored semantic-similarity chip shown on search result cards and QA
 * sources. The tone encodes match strength at a glance:
 *
 * - strong ≥ 65% (green)  — the passage is a close semantic match
 * - partial 35–64% (amber) — some overlap, weaker signal
 * - weak < 35% (red)       — retrieved only because nothing matched better
 *
 * The tooltip carries the exact similarity so the rounded label never hides
 * the precise score. Colors reuse the Badge tone pairs (theme-aware).
 */
export function MatchChip({ pct }: MatchChipProps) {
  const clamped = Math.min(100, Math.max(0, pct));
  const tone = clamped >= 65 ? "strong" : clamped >= 35 ? "partial" : "weak";
  return (
    <span className={`result-match-chip tone-${tone}`} title={`Similarity: ${clamped.toFixed(1)}%`}>
      {Math.round(clamped)}% match
    </span>
  );
}
