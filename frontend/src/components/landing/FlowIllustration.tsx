/**
 * The upload → search → ask flow, as one inline illustration for the landing
 * page's "How it works" section.
 *
 * Why this exists: #580 reported the page as "a lot of text and not much to
 * look at", and the measured reason was that the 2,870px between the hero and
 * the CTA band — 45% of the page — contained no imagery at all. The three step
 * cards beside it each carry a single 24×24 stroked glyph, which says what a
 * step is called and nothing about what it does to the document. This draws the
 * document's actual journey: whole on the left, cut into chunks and embedded in
 * the middle, quoted back on the right.
 *
 * Rules it holds to, matching `StageIllustration` on `/how-it-works`:
 *
 * **Inline SVG, not a bitmap.** No asset to fetch, no second request, scales to
 * any width without a second breakpoint, and recolours with the theme because
 * there are no baked-in pixels (#580 requires SVG and forbids bitmaps).
 *
 * **Every tone comes from `currentColor` or an accent variable**, never a hex.
 * A hard-coded fill is a dark-theme contrast failure waiting to happen.
 *
 * **It carries nothing a screen reader needs.** The step cards next to it state
 * all of this in words, so the whole figure is `aria-hidden`. An illustration
 * that repeats its own caption is noise, not information.
 */
export function FlowIllustration() {
  return (
    <svg
      className="flow-illustration"
      viewBox="0 0 520 200"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* One arrowhead, referenced by every connector. */}
        <marker
          id="flow-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" opacity="0.55" />
        </marker>
      </defs>

      {/* Connectors first, so the stages draw over them. Each runs the gap it
          actually has to cross — stage 2's cards are offset, so at y=100 only
          the middle one is present and the boundary is its own edges (191 and
          309), not the fan's bounding box. Both gaps are therefore 39 wide,
          and each tip lands exactly on the border it points at instead of
          stopping short of it or running through it. */}
      <g stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#flow-arrow)">
        <path d="M 152 100 H 191" fill="none" />
        <path d="M 309 100 H 348" fill="none" />
      </g>

      {/* 1. The whole document: a page with lines of text. */}
      <g transform="translate(28 44)" data-accent="blue">
        <rect x="0" y="0" width="124" height="112" rx="8" fill="currentColor" opacity="0.08" />
        <rect
          x="0"
          y="0"
          width="124"
          height="112"
          rx="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        {/* Text lines, varied in length so it reads as prose, not a table. */}
        <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.5">
          <path d="M 18 26 H 100" />
          <path d="M 18 42 H 106" />
          <path d="M 18 58 H 78" />
          <path d="M 18 74 H 104" />
          <path d="M 18 90 H 62" />
        </g>
      </g>

      {/* 2. The same document, cut into chunks and embedded. Three offset
          cards read as "the same page, sliced", which is what chunking is.
          y=43 rather than 34 so the fan's centre (43+157)/2 = 100 is the same
          centreline stages 1 and 3 sit on — at 34 it sat 9 above them and both
          connectors crossed the stack off-centre. x=183 puts 31 of clearance
          on both sides (183-152 and 348-317), where 196 left 44 and 18. */}
      <g transform="translate(183 43)" data-accent="violet">
        {[0, 34, 68].map((y, i) => (
          <g key={y} transform={`translate(0 ${y})`}>
            <rect
              x={i * 8}
              y="0"
              width="118"
              height="46"
              rx="7"
              fill="currentColor"
              opacity={0.08 + i * 0.02}
            />
            <rect
              x={i * 8}
              y="0"
              width="118"
              height="46"
              rx="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity={0.75}
            />
            {/* A two-line fragment inside each chunk. */}
            <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5">
              <path d={`M ${18 + i * 8} 17 H ${72 + i * 8}`} />
              <path d={`M ${18 + i * 8} 29 H ${98 + i * 8}`} />
            </g>
          </g>
        ))}
      </g>

      {/* 3. Points in a field: the embedding, drawn as the vector space the
          search actually runs in. Positions are fixed, not random, so the
          figure is identical on every render. */}
      <g transform="translate(348 34)" data-accent="green">
        <rect x="0" y="0" width="144" height="132" rx="8" fill="currentColor" opacity="0.05" />
        <rect
          x="0"
          y="0"
          width="144"
          height="132"
          rx="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        {/* The query, marked larger and in the accent, near three neighbours. */}
        <circle cx="72" cy="66" r="7" fill="currentColor" />
        <g fill="currentColor" opacity="0.6">
          <circle cx="52" cy="44" r="3.5" />
          <circle cx="95" cy="48" r="3.5" />
          <circle cx="58" cy="92" r="3.5" />
          <circle cx="100" cy="95" r="3.5" />
        </g>
        {/* The rest of the corpus, dimmer. */}
        <g fill="currentColor" opacity="0.28">
          <circle cx="30" cy="24" r="2.5" />
          <circle cx="118" cy="28" r="2.5" />
          <circle cx="22" cy="62" r="2.5" />
          <circle cx="126" cy="66" r="2.5" />
          <circle cx="34" cy="112" r="2.5" />
          <circle cx="112" cy="114" r="2.5" />
        </g>
      </g>

      {/* 4. The answer, as a quoted line — the point of the whole pipeline.
          x=358 centres it under stage 3 (348..492, so 358..482 leaves 10 each
          side); 368 was flush against the panel's right edge and inset 20 on
          the left, which read as a misalignment. The stroke runs at 0.8: at
          0.6 the accent only reaches 2.5:1 on light, and this is the one
          element whose tone is the accent rather than the page ink. */}
      <g transform="translate(358 176)" data-accent="blue">
        <rect x="0" y="0" width="124" height="20" rx="6" fill="currentColor" opacity="0.1" />
        <rect
          x="0"
          y="0"
          width="124"
          height="20"
          rx="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          opacity="0.8"
        />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5">
          <path d="M 12 10 H 86" />
        </g>
      </g>
    </svg>
  );
}
