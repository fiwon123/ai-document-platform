import type { DocumentView } from "./DocumentViewToggle";

const STORAGE_KEY = "askdocs-documents-view";

/**
 * Read the stored layout, defaulting to grid (#587).
 *
 * Deliberately tolerant: a `localStorage` read can throw (Safari private mode, a
 * storage-partitioned iframe, another tab having written a non-string), and an
 * unknown or corrupt value falls back to the default rather than blanking the
 * page. Persisting a *view preference* is not worth an error boundary — and the
 * failure is silent, so the worst outcome is that the preference does not stick.
 *
 * Only the literal `"table"` selects table. A future view added to the type
 * would need this widened deliberately, which is the point: reading `any` stored
 * string would let a stale or hand-edited value select a view that no longer
 * exists.
 */
export function readStoredView(): DocumentView {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "table" ? "table" : "grid";
  } catch {
    return "grid";
  }
}

export function writeStoredView(view: DocumentView): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Not being able to remember the preference must not break the toggle.
  }
}

export const DOCUMENTS_VIEW_STORAGE_KEY = STORAGE_KEY;
