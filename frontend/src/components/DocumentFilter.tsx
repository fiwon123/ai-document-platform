import { useEffect, useState } from "react";
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
 */
export function DocumentFilter({ selected, onChange }: DocumentFilterProps) {
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

  return (
    <div className="document-filter">
      <strong>Search in:</strong>
      {error && <span className="filter-note error-message"> {error}</span>}
      <label className="filter-option">
        <input
          type="checkbox"
          checked={selected.length === 0}
          onChange={() => onChange([])}
        />
        All documents
      </label>
      {docs.map((doc) => (
        <label key={doc.id} className="filter-option">
          <input
            type="checkbox"
            checked={selected.includes(doc.id)}
            onChange={() => toggle(doc.id)}
          />
          {doc.filename}
        </label>
      ))}
    </div>
  );
}