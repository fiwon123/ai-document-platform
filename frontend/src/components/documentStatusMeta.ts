import type { DocumentStatus } from "../types";

/**
 * What each document status means, in words, plus what is happening right now
 * and what the user can do about it (#587).
 *
 * The page previously showed *that* a document was `pending` / `ready` /
 * `failed` and nothing else. A status name is an internal value: it tells
 * someone who already knows the pipeline what the machine recorded, and tells
 * everyone else nothing. "failed" in particular says nothing about whether the
 * file was rejected at upload, whether processing gave up, or what to do next.
 *
 * Kept as data rather than JSX so **both** the grid card and the table row can
 * render from one source — see `DocumentStatusCell`. The parity requirement in
 * #587 ("no column, badge or field that only exists in one view") is otherwise
 * a thing to remember in two places, and one of them will drift.
 *
 * Lives apart from any component file so those modules export only their
 * component: a component file that also exports a plain constant disables Fast
 * Refresh, turning every edit to it into a full page reload. Same reasoning as
 * `documentStatusTone.ts`.
 *
 * There is deliberately **no** `tone` field here. The badge colour is a single
 * mapping in `documentStatusTone.ts`, already consumed by the dashboard and
 * asserted in `Badge.test.tsx`; a second copy in this file would be a second
 * thing to forget when a status is added, and the two views would quietly stop
 * agreeing with the dashboard.
 */
export interface DocumentStatusMeta {
  /** Capitalised status name, as shown in the badge. */
  readonly label: string;
  /** One line: what this status means. */
  readonly meaning: string;
  /** One line: what the platform is doing at this moment. */
  readonly doingNow: string;
  /** One line: what the user can do next, or what to expect instead. */
  readonly nextStep: string;
}

export const DOCUMENT_STATUS_META: Record<DocumentStatus, DocumentStatusMeta> = {
  pending: {
    label: "Pending",
    meaning: "Uploaded and queued, not started yet.",
    doingNow: "Waiting for a worker to pick it up.",
    nextStep: "Nothing to do — this normally clears within a minute.",
  },
  processing: {
    label: "Processing",
    meaning: "Being read, split into chunks and embedded for search.",
    doingNow: "Extracting text and generating embeddings.",
    nextStep: "Nothing to do — search and Ask unlock when it reaches Ready.",
  },
  ready: {
    label: "Ready",
    meaning: "Fully processed and searchable.",
    doingNow: "Indexed and available to Search and Ask.",
    nextStep: "Preview it, download it, or ask a question about it.",
  },
  failed: {
    label: "Failed",
    meaning: "Processing stopped before the document became searchable.",
    doingNow: "Nothing — it needs another attempt.",
    nextStep:
      "Use Retry to run it again. If it keeps failing, the file may be corrupt or unreadable.",
  },
};

/**
 * Fallback for a status this build does not know about (an older or
 * provider-specific value arriving from the API). Deliberately says so rather
 * than rendering an empty explanation, which would read as a bug.
 */
const UNKNOWN_STATUS: DocumentStatusMeta = {
  label: "Unknown",
  meaning: "This status is not recognised by this version of the app.",
  doingNow: "Nothing — the document is not being processed.",
  nextStep: "Retry it, or reload the page if it persists.",
};

export function documentStatusMeta(status: DocumentStatus): DocumentStatusMeta {
  return DOCUMENT_STATUS_META[status] ?? UNKNOWN_STATUS;
}

/** Statuses that show an elapsed-time label and a progress bar. */
export function isProcessing(status: DocumentStatus): boolean {
  return status === "pending" || status === "processing";
}
