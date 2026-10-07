import type { Accent } from "../../content/marketing";

/**
 * Per-stage SVG scenes for the `/how-it-works` pipeline.
 *
 * These are illustrations, not icons: the old pipeline used a single 24×24
 * stroked glyph per stage (`ICONS.upload`, `ICONS.bolt`, …), which is the same
 * mark six times over and says nothing about *what that stage does*. Each scene
 * here shows the stage's actual subject — a file leaving a tray, a page being
 * read, a document cut into windows, points in a vector field — so the sequence
 * reads as a process even before the text is parsed.
 *
 * Two rules keep them honest:
 *
 * **They carry no information a screen reader needs.** Every glyph is
 * `aria-hidden` and `focusable="false"`, because the stage title, summary,
 * detail and outcome already say all of it in words. An illustration that
 * duplicates its own caption is noise for a screen reader, not a bonus.
 *
 * **They theme themselves from `currentColor`, not from literals.** Every tone
 * comes from `--card-accent` (restated per accent and per theme by the existing
 * `[data-accent]` blocks) or from the soft wash derived from it, so light and
 * dark need no rule here at all — a hard-coded hex would be a dark-theme
 * contrast failure waiting to happen. The soft fills use `currentColor` at low
 * opacity for the same reason: one colour, two intensities.
 */

export type StageKey = "upload" | "extract" | "chunk" | "embed" | "search" | "ask";

/** Shared geometry. 64×64 viewBox, 1.6 stroke, round caps — one visual weight. */
const VIEW = 64;
const SW = 1.6;

const Stroke = ({ d, fill = "none", opacity }: { d: string; fill?: string; opacity?: number }) => (
  <path
    d={d}
    fill={fill}
    stroke="currentColor"
    strokeWidth={SW}
    strokeLinecap="round"
    strokeLinejoin="round"
    opacity={opacity}
  />
);

/** A soft wash of the accent, so the scene has a ground without a second hue. */
const Wash = ({ d, opacity = 0.1 }: { d: string; opacity?: number }) => (
  <path d={d} fill="currentColor" opacity={opacity} />
);

const scenes: Record<StageKey, () => React.JSX.Element> = {
  /* A file leaving the upload tray: the page is still intact, the arrow is the
     one moment the request is synchronous. */
  upload: () => (
    <>
      <Wash d="M16 6h20l12 12v34a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4Z" opacity={0.08} />
      <Stroke d="M16 6h20l12 12v34a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4Z" />
      <Stroke d="M36 6v12h12" />
      {/* text lines on the page */}
      <Stroke d="M20 28h12M20 34h12M20 40h7" opacity={0.45} />
      {/* the arrow leaving the tray */}
      <Stroke d="M40 46V30M40 30l-6 6M40 30l6 6" />
      <Stroke d="M18 52h28" opacity={0.45} />
    </>
  ),

  /* The worker reading a page: text lines lifted off the sheet, with the
     first-page thumbnail rendered as the small frame. */
  extract: () => (
    <>
      <Wash d="M14 8h24v48H14z" opacity={0.08} />
      <Stroke d="M14 8h24v48H14z" />
      <Stroke d="M20 18h12M20 25h12M20 32h8" opacity={0.45} />
      {/* thumbnail chip */}
      <Stroke d="M20 44h12v8H20z" opacity={0.45} />
      {/* The magnifying lens, over the text — and FILLED with the tile colour.

          An unfilled circle is only correct when nothing is behind it. This one
          spans x29-51 while the page behind it ends at x=38, so its outline sat
          on top of the document's right edge and the ends of the text lines ran
          visibly through its interior. The fill is `var(--stage-tile)`, which
          `.stage-illustration` defines as its own background, so the lens
          occludes the page exactly and matches the tile in both themes without
          a hard-coded hex. Drawn after everything it covers, before the handle. */}
      <circle cx="40" cy="37" r="11" style={{ fill: "var(--stage-tile)" }} />
      <Stroke d="M40 26a11 11 0 1 0 0 22 11 11 0 0 0 0-22Z" />
      <Stroke d="m48.5 42.5 7 7" />
    </>
  ),

  /* Overlapping windows: the same page cut into passages, with the overlap
     drawn explicitly because that is the part people get wrong. */
  chunk: () => (
    <>
      <Wash d="M10 12h30v40H10z" opacity={0.08} />
      <Stroke d="M10 12h30v40H10z" opacity={0.55} />
      {/* the cut offsets, each sharing a band with its neighbour */}
      <Wash d="M18 16h30v36H18z" opacity={0.12} />
      <Stroke d="M18 16h30v36H18z" />
      <Wash d="M26 20h30v32H26z" opacity={0.16} />
      <Stroke d="M26 20h30v32H26z" />
      <Stroke d="M22 30h8M22 42h8M30 30h8M30 42h8M38 30h6M38 42h6" opacity={0.4} />
    </>
  ),

  /* Chunks becoming points in a vector field: a dot per chunk, arranged by
     similarity rather than by position. */
  embed: () => (
    <>
      <Stroke d="M10 12h30v40H10z" opacity={0.4} />
      <Stroke d="M16 20h8M16 27h8M16 34h5" opacity={0.3} />
      {/* the arrow out of the page into the field */}
      <Stroke d="M40 32h6M44 29l3 3-3 3" opacity={0.6} />
      <Wash d="M46 10a26 26 0 0 1 0 44Z" opacity={0.07} />
      {/* points in the field */}
      <circle cx="50" cy="22" r="2.4" fill="currentColor" />
      <circle cx="56" cy="32" r="1.8" fill="currentColor" opacity={0.75} />
      <circle cx="49" cy="38" r="2" fill="currentColor" opacity={0.85} />
      <circle cx="55" cy="46" r="1.6" fill="currentColor" opacity={0.6} />
      <circle cx="50" cy="50" r="1.3" fill="currentColor" opacity={0.5} />
    </>
  ),

  /* The query ranked against the corpus: one query line, three results
     ordered by distance. */
  search: () => (
    <>
      <Wash d="M8 12h48v10H8z" opacity={0.1} />
      <Stroke d="M8 12h48v10H8z" opacity={0.7} />
      <Stroke d="M13 17h16" opacity={0.5} />
      {/* ranked results, longest bar first */}
      <Stroke d="M8 30h40" />
      <Stroke d="M8 40h30" opacity={0.6} />
      <Stroke d="M8 50h19" opacity={0.4} />
      {/* distance ticks */}
      <Stroke d="M52 28v4M46 38v4M40 48v4" opacity={0.45} />
    </>
  ),

  /* The answer, grounded: a chat bubble whose tail is tied back to the
     passages it was built from. */
  ask: () => (
    <>
      <Wash
        d="M10 10h44v32a4 4 0 0 1-4 4H26l-12 9V46h-4a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Z"
        opacity={0.09}
      />
      <Stroke d="M10 10h44v32a4 4 0 0 1-4 4H26l-12 9V46h-4a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4Z" />
      <Stroke d="M18 22h28M18 31h18" opacity={0.5} />
      {/* The grounding, tied to the bubble: one drop from the bubble's floor to
          a bracket, then a stub down into each of the two source chips. The
          previous version drew two bare dashes with a single drop line landing
          in the gap between them, so one chip was joined to nothing at all. */}
      <Stroke d="M32 46v6" opacity={0.45} />
      <Stroke d="M20 52h24" opacity={0.45} />
      <Stroke d="M20 52v3M44 52v3" opacity={0.45} />
      <Stroke d="M15 55h11v6H15z" opacity={0.5} />
      <Stroke d="M38 55h11v6H38z" opacity={0.5} />
    </>
  ),
};

export function StageIllustration({ stage, accent }: { stage: StageKey; accent: Accent }) {
  const scene = scenes[stage];
  if (!scene) return null;

  return (
    <span className="stage-illustration" data-accent={accent}>
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        width="64"
        height="64"
        aria-hidden="true"
        focusable="false"
      >
        {scene()}
      </svg>
    </span>
  );
}
