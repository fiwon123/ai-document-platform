import type { Document } from "../types";
import { useState } from "react";
import { formatElapsed } from "../utils/time";
import { Badge } from "./Badge";
import { documentStatusMeta, isProcessing } from "./documentStatusMeta";
import { DOCUMENT_STATUS_TONE } from "./documentStatusTone";

/**
 * The one place a document's status is rendered (#587).
 *
 * Both the grid card and the table row call this, so the parity requirement —
 * "no column, badge or field that only exists in one view" — is structural
 * rather than a convention to remember. The alternative is two renderers that
 * agree today, and the guarantee decays the first time someone adds a field to
 * the one they are looking at.
 *
 * `layout` picks the arrangement only:
 *   - `stacked` for the card, where the three lines sit under the badge;
 *   - `inline`  for the table, where the badge and one summary line share a row
 *                and the remaining two lines follow.
 *
 * Both arrangements render *the same* three lines (`meaning`, `doingNow`,
 * `nextStep`) plus the badge, elapsed time and error detail. Neither drops a
 * field to fit, which is what keeps the two views honest: a field that would
 * not fit the table has to be shortened or wrapped, not deleted.
 */
export function DocumentStatusCell({
  doc,
  layout,
}: {
  doc: Document;
  layout: "stacked" | "inline";
}) {
  const meta = documentStatusMeta(doc.status);
  const processing = isProcessing(doc.status);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`doc-status doc-status--${layout} ${expanded ? "is-expanded" : ""}`}>
      <div className="doc-status-head">
        <Badge tone={DOCUMENT_STATUS_TONE[doc.status] ?? "gray"}>{meta.label}</Badge>
        {processing && (
          <span
            className="status-elapsed"
            title={`${doc.status} for ${formatElapsed(doc.updated_at)}`}
          >
            {formatElapsed(doc.updated_at)}
          </span>
        )}
      </div>

      {processing && (
        <span className="progress-track" aria-hidden="true">
          <span className="progress-bar" />
        </span>
      )}

      {layout === "inline" && (
        <button
          type="button"
          className="status-details-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      )}

      {/* The label says which line is which. Without it, three sentences of
          status copy read as one undifferentiated paragraph — which is how
          "what can I do about it" becomes invisible next to "what is it doing". */}
      <dl className={`doc-status-explain ${layout === "inline" && !expanded ? "is-collapsed" : ""}`}>
        <div className="doc-status-explain-row">
          <dt>Meaning</dt>
          <dd>{meta.meaning}</dd>
        </div>
        <div className="doc-status-explain-row">
          <dt>Now</dt>
          <dd>{meta.doingNow}</dd>
        </div>
        <div className="doc-status-explain-row">
          <dt>Next</dt>
          <dd>{meta.nextStep}</dd>
        </div>
      </dl>

      {doc.error_message && (
        <p className="error-detail">
          <span className="doc-status-error-label">Reported error:</span>{" "}
          {doc.error_message}
        </p>
      )}
    </div>
  );
}
