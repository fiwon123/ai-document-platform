import { useEffect, useRef, useState } from "react";
import { DocumentFilter } from "../components/DocumentFilter";
import { EmptyState } from "../components/EmptyState";
import { search } from "../services/api";
import type { SearchResult } from "../types";
import { Spinner } from "../components/Spinner";

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 5;

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<SearchResult[]>([]);

  // Keep the latest results in a ref so "load more" can compute the next
  // offset without stale-closure issues from the debounced effect.
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  async function runSearch(q: string, ids: string[], offset = 0) {
    if (!q.trim()) return;
    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const response = await search.search(q, PAGE_SIZE, ids, offset);
      if (offset === 0) {
        setResults(response.results);
        resultsRef.current = response.results;
      } else {
        const merged = [...resultsRef.current, ...response.results];
        resultsRef.current = merged;
        setResults(merged);
      }
      setTotalCount(response.total_count);
      setHasMore(response.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }

  async function loadMore() {
    setIsLoadingMore(true);
    await runSearch(query, selectedIds, resultsRef.current.length);
  }

  // Debounced auto-search as the user types or changes the document filter.
  // A new query always starts from the first page (offset 0).
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setTotalCount(0);
      setHasMore(false);
      setHasSearched(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void runSearch(query, selectedIds);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedIds]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void runSearch(query, selectedIds);
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Semantic Search</h1>
        <p>Search through your documents using natural language</p>
      </header>

      <form onSubmit={handleSearch} className="search-form">
        <div className="search-input-group">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your documents..."
            aria-label="Search your documents"
            className="search-input"
            disabled={isLoading}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading || !query.trim()}
          >
            {isLoading ? "Searching..." : "Search"}
          </button>
        </div>
      </form>

      <DocumentFilter selected={selectedIds} onChange={setSelectedIds} />

      {error && <p className="error-message" role="alert">{error}</p>}

      {isLoading && (
        <div className="loading">
          <Spinner size={20} label="Searching" />
          <span>Searching…</span>
        </div>
      )}

      {!isLoading && hasSearched && results.length === 0 && (
        <EmptyState
          title="No results found"
          description={`Nothing matched "${query}". Try different keywords.`}
          action={{ label: "Clear search", onClick: () => setQuery("") }}
        />
      )}

      {results.length > 0 && (
        <div className="search-results">
          <h2>Results ({totalCount})</h2>
          {results.map((result) => (
            <div key={result.chunk_id} className="search-result-card">
              <div className="result-header">
                <span className="result-document">
                  {result.document_filename}
                </span>
                <span className="result-score">
                  Similarity: {Math.max(0, (1 - result.score) * 100).toFixed(1)}%
                </span>
              </div>
              <p className="result-content">{result.content}</p>
              {result.metadata_ && (
                <div className="result-metadata">
                  {Object.entries(result.metadata_).map(([key, value]) => (
                    <span key={key} className="metadata-tag">
                      {key}: {String(value)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {hasMore && (
            <div className="search-load-more">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? "Loading…" : "Load more results"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}