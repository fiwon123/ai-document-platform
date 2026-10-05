import type { CSSProperties } from "react";
import { PIPELINE_STAGES } from "../../content/marketing";
import { useScrollProgress } from "../../hooks/useScrollProgress";
import { Reveal } from "../Reveal";
import { StageIllustration, type StageKey } from "./StageIllustration";

/**
 * The six-stage pipeline, drawn as one connected sequence rather than six
 * stacked cards.
 *
 * Before #582 each stage was an independent bordered card in a vertical list,
 * so the page showed *six things* where it should have shown *one process*. The
 * connective tissue was missing: no rail, no node per stage, and nothing tying
 * stage 3's output to stage 4's input.
 *
 * Three decisions worth stating, because each is load-bearing:
 *
 * **The rail is drawn, not implied.** It is one continuous line down the
 * leading edge with a node at each stage, so the connection exists in the
 * static frame — the "connections are legible without animation" requirement.
 * The scroll build-up only *reveals* that line; it never creates it. This is
 * why `useScrollProgress` reports 1 (not 0) whenever it cannot animate.
 *
 * **The sequence is an ordered list in the DOM.** `<ol>` with the stage number
 * marked `aria-hidden`, because the list itself conveys order to assistive tech
 * and a second source of numbering is read twice. The rail and nodes are
 * `aria-hidden` decoration.
 *
 * **The failed branch is drawn as a branch, not a footnote.** Stage 2 is where
 * a document can fail, so that is where the failure path leaves the rail. A
 * page that explains a pipeline honestly has to say what happens when a stage
 * does not complete, and a sentence at the bottom of the page is not where a
 * reader looks when they are wondering about errors.
 */

const stageKey = (title: string): StageKey => {
  const key = title.split(".")[1]?.trim().toLowerCase();
  return (["upload", "extract", "chunk", "embed", "search", "ask"] as const).includes(
    key as StageKey,
  )
    ? (key as StageKey)
    : "upload";
};

export function PipelineTrack() {
  const { ref, style } = useScrollProgress<HTMLDivElement>();

  return (
    <div className="pipeline-track" ref={ref} style={style}>
      {/* The rail. Two elements rather than one gradient so the drawn portion
          can be a solid accent and the remaining portion a track, which reads
          as progress rather than as a decoration. */}
      <div className="pipeline-rail" aria-hidden="true">
        <span className="pipeline-rail-track" />
        <span className="pipeline-rail-fill" />
      </div>

      <ol className="pipeline">
        {PIPELINE_STAGES.map((stage, index) => (
          <li
            key={stage.title}
            className="pipeline-stage"
            data-accent={stage.accent}
            /* Stage 2 is the only stage that can fail a document, so it is the
               only one that carries a branch. */
            data-branch={index === 1 ? "failure" : undefined}
            style={{ "--stage-index": index } as CSSProperties}
          >
            {/* Node on the rail: the stage's position in the sequence, drawn. */}
            <span className="pipeline-node" aria-hidden="true" />

            <Reveal variant="up" delay={0}>
              <div className="pipeline-stage-inner">
                <div className="pipeline-stage-lead">
                  <StageIllustration stage={stageKey(stage.title)} accent={stage.accent} />

                  <div className="pipeline-stage-head">
                    <h3>
                      {/* Decoration: the list already conveys order. */}
                      <span className="pipeline-stage-number" aria-hidden="true">
                        {index + 1}
                      </span>
                      {stage.title.replace(/^\d+\.\s*/, "")}
                    </h3>
                    <p className="pipeline-summary">{stage.summary}</p>
                  </div>
                </div>

                <div className="pipeline-stage-detail">
                  <p className="pipeline-detail">{stage.detail}</p>
                </div>

                {/* The facts sit in the LEAD column, not beside the detail.
                    With them on the right, the right column filled the card and
                    the left held ~80px of content in a ~400px box — 79% empty,
                    which is the same dead-lane problem this change set out to
                    fix, moved from the page into the card. */}
                <ul className="pipeline-facts">
                  {stage.facts.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>

                {/* What the user gets, which is not the same as what the
                    system does — the acceptance criterion that distinguishes a
                    pipeline walkthrough from a status-code listing. It spans
                    the full card because it is the punchline of the stage, and
                    it is the one line here that benefits from width. */}
                <p className="pipeline-outcome">
                  <span className="pipeline-outcome-label">You get</span>
                  {stage.outcome}
                </p>
              </div>
            </Reveal>

            {/* The failure branch leaves the rail at stage 2 — the only stage
                that can fail a document.

                The branch is drawn by two CSS pieces on the panel itself: a
                dashed left border plus a `::before` horizontal arm that reaches
                back across the card gutter to the rail. An earlier version of
                this comment claimed the dashed border alone "lands exactly on
                the rail's x", which was false — the panel sits ~29px right of
                the rail in the card's content column, so the border rendered as
                a rule floating inside the card with 29px of empty background to
                its left and the rail running past, unjoined. */}
            {index === 1 && (
              <aside className="pipeline-failure" role="note" data-accent="rose">
                <p className="pipeline-failure-title">
                  <span className="pipeline-failure-dot" aria-hidden="true" />
                  If extraction fails
                </p>
                <p>
                  A file that cannot be parsed — an encrypted PDF, a scanned
                  image with no text layer, a truncated upload — is marked{" "}
                  <code>failed</code> and the reason is attached to the
                  document. It is not retried silently forever, and it does not
                  take the rest of the workspace down with it: search and Q&amp;A
                  keep serving the documents that did succeed, and a failed
                  upload can be replaced.
                </p>
                <p className="pipeline-failure-states">
                  <code>pending</code> → <code>processing</code> →{" "}
                  <code>ready</code>, or <code>failed</code> with a reason
                </p>
              </aside>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
