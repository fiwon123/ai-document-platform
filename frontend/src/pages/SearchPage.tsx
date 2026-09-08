import { useState } from "react";
import { DocumentFilter } from "../components/DocumentFilter";
import { search } from "../services/api";
import type { SearchResult } from "../types";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const response = await search.search(query, 5, selectedIds);
      setResults(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setIsLoading(false);
    }
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

      {error && <p className="error-message">{error}</p>}

      {isLoading && <div className="loading">Searching...</div>}

      {!isLoading && hasSearched && results.length === 0 && (
        <div className="empty-state">
          <p>No results found for "{query}"</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="search-results">
          <h2>Results ({results.length})</h2>
          {results.map((result) => (
            <div key={result.chunk_id} className="search-result-card">
              <div className="result-header">
                <span className="result-document">
                  {result.document_filename}
                </span>
                <span className="result-score">
                  Score: {(result.score * 100).toFixed(1)}%
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
        </div>
      )}
    </div>
  );
}
