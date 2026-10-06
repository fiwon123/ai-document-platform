import { PIPELINE_STAGES } from "../../content/marketing";

/**
 * The architecture diagram for `/features` → "How the pieces fit together".
 *
 * That section is the one place a visitor goes to understand how the product is
 * built, and it was two paragraphs of prose in a 52ch column with the right half
 * of the page empty (#581). The diagram earns that half: it is the only place
 * the *shape* of the system is visible — one request path, one worker, two
 * readers of the same index.
 *
 * ## Routing
 *
 * The hard-won rule, after a review found three connectors drawn through boxes:
 *
 * **No connector passes through a box.** A line drawn over a label reads as a
 * rendering bug rather than as routing, and nothing in the drawing tells the
 * viewer it was meant to. So the read path from the index to the two readers
 * takes a staircase through empty space — right, up, right, up, left — rather
 * than the obvious straight run down the right column, which would cross both
 * the Ask and Object storage boxes.
 *
 * `ArchitectureDiagram.test.tsx` enforces that geometrically (segment/rect
 * intersection) rather than leaving it to a screenshot, because the first
 * version of this drawing failed it in all six captures and a picture review is
 * a poor regression gate for geometry.
 *
 * **One crossing is deliberate.** The API's write to object storage crosses the
 * index's read path once, in the gutter at (265, 250). They are two different
 * flows, and a crossing between connectors in empty space is legible in a way
 * that a crossing through a box is not. It is bounded by the test as well.
 *
 * ## Colour and text
 *
 * **It is inline SVG themed from `currentColor`.** Every tone is either
 * `currentColor` at a stated opacity or a token, so dark theme needs no rule
 * here — the same approach `StageIllustration` and `FlowIllustration` take.
 *
 * **No text is faded with `opacity`.** A review measured five of the seven box
 * subtitles between 2.84:1 and 4.23:1 against their own box fill, because 0.7
 * opacity of a mid-tone accent is not text any more. Hierarchy comes from size
 * and weight instead, which is why `.arch-sub` has no opacity at all.
 *
 * **The diagram is decorative; the text is not.** Unlike the landing flow
 * figure, this one carries information that is nowhere else on the page, so
 * `aria-hidden` alone would leave a screen-reader user with no way to get the
 * architecture — which is exactly what #581 asks for. The SVG is hidden and a
 * `<ul>` text equivalent carries the same three groups, driven from the same
 * `PIPELINE_STAGES` data. One source, two presentations: add a stage to the
 * pipeline and both change.
 */
export function ArchitectureDiagram() {
  return (
    <div className="architecture">
      <div className="architecture-scroll">
        <svg
          className="architecture-diagram"
          viewBox="0 0 480 350"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <marker
              id="arch-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" opacity="0.75" />
            </marker>
          </defs>

          {/* ---------------- left column: the write path -------------------- */}
          <g data-accent="blue">
            <rect x="0" y="8" width="150" height="52" rx="9" fill="currentColor" opacity="0.06" />
            <rect
              x="0"
              y="8"
              width="150"
              height="52"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="75" y="28" className="arch-label" textAnchor="middle">
              Browser
            </text>
            <text x="75" y="46" className="arch-sub" textAnchor="middle">
              upload · search · ask
            </text>
          </g>

          <path d="M 75 60 V 92" className="arch-link" markerEnd="url(#arch-arrow)" />

          {/* The API. On the request path, and where both the queue and the
            object-store write start. */}
          <g data-accent="violet">
            <rect x="0" y="96" width="150" height="60" rx="9" fill="currentColor" opacity="0.07" />
            <rect
              x="0"
              y="96"
              width="150"
              height="60"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <text x="75" y="120" className="arch-label" textAnchor="middle">
              FastAPI
            </text>
            <text x="75" y="138" className="arch-sub" textAnchor="middle">
              auth · validation
            </text>
          </g>

          <path d="M 75 156 V 186" className="arch-link" markerEnd="url(#arch-arrow)" />

          <g data-accent="amber">
            <rect x="0" y="190" width="150" height="46" rx="9" fill="currentColor" opacity="0.07" />
            <rect
              x="0"
              y="190"
              width="150"
              height="46"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="75" y="209" className="arch-label" textAnchor="middle">
              Redis queue
            </text>
            <text x="75" y="225" className="arch-sub" textAnchor="middle">
              arq worker
            </text>
          </g>

          <path d="M 75 236 V 268" className="arch-link" markerEnd="url(#arch-arrow)" />

          {/* ---------------- right column: the two readers ------------------ */}
          <g data-accent="violet">
            <rect
              x="300"
              y="40"
              width="150"
              height="46"
              rx="9"
              fill="currentColor"
              opacity="0.07"
            />
            <rect
              x="300"
              y="40"
              width="150"
              height="46"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="375" y="59" className="arch-label" textAnchor="middle">
              Search
            </text>
            <text x="375" y="75" className="arch-sub" textAnchor="middle">
              nearest chunks
            </text>
          </g>

          <g data-accent="blue">
            <rect
              x="300"
              y="112"
              width="150"
              height="46"
              rx="9"
              fill="currentColor"
              opacity="0.07"
            />
            <rect
              x="300"
              y="112"
              width="150"
              height="46"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="375" y="131" className="arch-label" textAnchor="middle">
              Ask
            </text>
            <text x="375" y="147" className="arch-sub" textAnchor="middle">
              answer + sources
            </text>
          </g>

          {/* ---------------- bottom band: storage and the index -------------- */}
          <g data-accent="green">
            <rect x="0" y="272" width="150" height="52" rx="9" fill="currentColor" opacity="0.06" />
            <rect
              x="0"
              y="272"
              width="150"
              height="52"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="75" y="292" className="arch-label" textAnchor="middle">
              Postgres
            </text>
            <text x="75" y="310" className="arch-sub" textAnchor="middle">
              pgvector index
            </text>
          </g>

          <g data-accent="rose">
            <rect
              x="300"
              y="272"
              width="150"
              height="52"
              rx="9"
              fill="currentColor"
              opacity="0.06"
            />
            <rect
              x="300"
              y="272"
              width="150"
              height="52"
              rx="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <text x="375" y="292" className="arch-label" textAnchor="middle">
              Object storage
            </text>
            <text x="375" y="310" className="arch-sub" textAnchor="middle">
              original file
            </text>
          </g>

          {/* ---------------- connectors ------------------------------------- */}
          {/* The API serves both readers. Straight runs, because nothing stands
            between the API and them at those heights. */}
          <path d="M 150 110 H 195 V 55 H 296" className="arch-link" markerEnd="url(#arch-arrow)" />
          <path
            d="M 150 126 H 195 V 127 H 296"
            className="arch-link"
            markerEnd="url(#arch-arrow)"
          />

          {/* The API writes the original file to object storage. The single
            deliberate crossing: it passes over the index's read path at
            (265, 250), which is empty space. */}
          <path
            d="M 150 146 H 265 V 286 H 296"
            className="arch-link"
            markerEnd="url(#arch-arrow)"
          />

          {/* The index read path, as a staircase: out of the index's right edge,
            up into the clear band above the bottom row, across to the right
            margin, then up to the readers' right edges. Every segment is in
            empty space, which is the whole point — see "Routing" above. */}
          <path
            d="M 150 298 H 225 V 250 H 470 V 71 H 454"
            className="arch-link"
            markerEnd="url(#arch-arrow)"
          />
          {/* Ask taps into that vertical run rather than duplicating it, so the
            "both readers read one index" relationship is a single line with a
            branch, not two lines that happen to be parallel. */}
          <path d="M 470 135 H 454" className="arch-link" markerEnd="url(#arch-arrow)" />
        </svg>
        <p className="architecture-hint">Scroll the diagram sideways to see the whole pipeline.</p>
      </div>

      {/* The text equivalent. Not decoration: this is the only place the
          architecture is described, so it has to be readable as text (#581). */}
      <div className="architecture-text">
        <h3>One request path, one background path</h3>
        <ul>
          <li>
            <strong>On the request path:</strong> the browser calls the API, which authenticates and
            validates. Search and Q&amp;A both read from the same vector index, so an answer is
            never a separate retrieval system.
          </li>
          <li>
            <strong>Off the request path:</strong> an upload is written to object storage and
            queued, and a background worker extracts, chunks and embeds it. A 25 MB PDF returns as
            fast as a 2 KB text file.
          </li>
          <li>
            <strong>What makes it work:</strong> {PIPELINE_STAGES.length} stages from file to answer
            — {PIPELINE_STAGES.map((s) => s.title.replace(/^\d+\.\s*/, "")).join(", ")} — all in one
            private workspace.
          </li>
        </ul>
      </div>
    </div>
  );
}
