import { memo, useEffect, useState } from "react";
import { documents } from "../services/api";
import type { Document } from "../types";
import { Spinner } from "./Spinner";

interface DocumentFilterProps {
  /** Currently selected document IDs (empty = all documents). */
  selected: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Lets the user scope search/Q&A to a subset of their documents.
 * No selection means "all documents".
 *
 * Rendered as compact, toggleable chips (one per document plus a leading
 * "All documents" chip) so long filenames wrap cleanly and every option is
 * easy to hit with a mouse or keyboard. Each chip is a real button with
 * ``aria-pressed`` (selected state), so the list stays accessible without
 * the visual weight of a checkbox column.
 *
 * Memoized: its props are state-sourced (stable array identity) and a
 * setState function, so parent re-renders (e.g. every search query
 * keystroke) skip re-rendering the whole option list.
 */
export const DocumentFilter = memo(function DocumentFilter({
  selected,
  onChange,
}: DocumentFilterProps) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    documents
      .list()
      .then((data) => {
        if (!cancelled) setDocs(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load documents");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((docId) => docId !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  if (isLoading) {
    return (
      <p className="filter-note">
        <Spinner size={14} label="Loading documents" />
        Loading documents…
      </p>
    );
  }

  if (docs.length === 0) {
    return null;
  }

  const allSelected = selected.length === 0;

  return (
    <div className="document-filter">
      <span className="document-filter-label">Search in:</span>
      {error && <span className="filter-note error-message"> {error}</span>}
      <div className="filter-chips" role="group" aria-label="Documents to search">
        <button
          type="button"
          className={`filter-chip${allSelected ? " is-selected" : ""}`}
          aria-pressed={allSelected}
          onClick={() => onChange([])}
          title="Search all documents"
        >
          {allSelected && <CheckIcon />}
          All documents
        </button>
        {docs.map((doc) => {
          const isSelected = selected.includes(doc.id);
          return (
            <button
              key={doc.id}
              type="button"
              className={`filter-chip${isSelected ? " is-selected" : ""}`}
              aria-pressed={isSelected}
              onClick={() => toggle(doc.id)}
              title={doc.filename}
            >
              {isSelected && <CheckIcon />}
              <span className="filter-chip-name">{doc.filename}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

/** Small inline checkmark used in selected chips (no icon dependency). */
function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}