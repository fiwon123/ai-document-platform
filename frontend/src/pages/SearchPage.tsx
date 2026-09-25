import { memo, useEffect, useRef, useState, useTransition } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { DocumentFilter } from "../components/DocumentFilter";
import { EmptyState } from "../components/EmptyState";
import { HighlightedText } from "../components/HighlightedText";
import { search } from "../services/api";
import type { SearchResult } from "../types";

const SEARCH_QUERY_KEY = ["search"] as const;

/** Example queries shown as clickable chips until the first search / when no
 *  results match — they fill the input and run the search immediately. */
const SUGGESTIONS = [
  "How does document processing work?",
  "Which documents mention security?",
  "Summarize the key onboarding steps",
  "What are the product highlights?",
];

interface SearchParams {
  q: string;
  ids: string;
}

interface SearchResultCardProps {
  result: SearchResult;
  query: string;
}

/**
 * Memoized result card. During typing the query prop changes so the
 * highlighted snippet re-renders, but unrelated page state (export toggles,
 * filters) does not force every card to rebuild.
 */
const SearchResultCard = memo(function SearchResultCard({
  result,
  query,
}: SearchResultCardProps) {
  const matchPct = Math.max(0, (1 - result.score) * 100);
  return (
    <div className="search-result-card">
      <div className="result-header">
        <span className="result-document">
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M6 3h8l4 4v14H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M14 3v4h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          {result.document_filename}
        </span>
        <span
          className="result-match-chip"
          title={`Similarity: ${((1 - result.score) * 100).toFixed(1)}%`}
        >
          {matchPct.toFixed(0)}% match
        </span>
      </div>
      <p className="result-content">
        <HighlightedText text={result.content} query={query} />
      </p>
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
  );
});

/** Shimmering placeholders shown while a search is in flight. */
function SearchSkeletons() {
  return (
    <div className="search-skeletons" role="status" aria-label="Searching">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-card search-skeleton">
          <div className="skeleton-card-header">
            <span className="skeleton" style={{ width: "40%" }} />
            <span className="skeleton" style={{ width: "15%" }} />
          </div>
          <div className="skeleton-card-body">
            <span className="skeleton" style={{ width: "100%" }} />
            <span className="skeleton" style={{ width: "82%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SuggestionChips({
  onPick,
  disabled,
}: {
  onPick: (suggestion: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="search-suggestions" aria-label="Suggested searches">
      {SUGGESTIONS.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className="suggestion-chip"
          onClick={() => onPick(suggestion)}
          disabled={disabled}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 5;

export function SearchPage() {
  const [query, setQuery] = useState("");
  // The debounced query + selected ids drive the actual fetches. Keeping the
  // two separated means typing updates the input instantly while the result
  // set only refreshes after the debounce window (or an explicit submit).
  const [searchParams, setSearchParams] = useState<SearchParams>({
    q: "",
    ids: "",
  });
  const [isExporting, setIsExporting] = useState<"csv" | "json" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Typing updates the input non-blockingly: the keystroke render is deferred
  // to a transition so long-running searches never jank the input itself.
  const [, startTransition] = useTransition();

  const idKey = selectedIds.join(",");
  const searchQuery = useInfiniteQuery({
    queryKey: [...SEARCH_QUERY_KEY, searchParams.q, searchParams.ids],
    queryFn: ({ pageParam }) =>
      search.search(searchParams.q, PAGE_SIZE, selectedIds, pageParam),
    initialPageParam: 0,
    // Search only starts once the user has actually searched something.
    enabled: searchParams.q.trim().length > 0,
    // While a newer search is in flight the previous results stay on screen
    // (lightweight placeholder) so the page never flashes empty.
    placeholderData: keepPreviousData,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.has_more
        ? allPages.reduce((total, page) => total + page.results.length, 0)
        : undefined,
  });

  const pages = searchQuery.data?.pages ?? [];
  const results = pages.flatMap((page) => page.results);
  const totalCount = pages[pages.length - 1]?.total_count ?? 0;
  const hasMore = pages[pages.length - 1]?.has_more ?? false;
  const hasSearched = searchParams.q.trim().length > 0;
  const isLoading = searchQuery.isPending && hasSearched;
  const isLoadingMore = searchQuery.isFetchingNextPage;
  const searchError = searchQuery.isError
    ? (searchQuery.error as Error).message
    : null;
  const errorMessage = searchError ?? error;

  // Debounced auto-search as the user types or changes the document filter.
  // A new query always starts from the first page (offset 0): the query key
  // changes with the query text and filter ids, which resets the pages.
  useEffect(() => {
    if (!query.trim()) {
      // Clearing the input immediately drops any pending debounce and resets
      // the result set (the query becomes disabled and renders nothing).
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSearchParams({ q: "", ids: "" });
      return;
    }

    debounceRef.current = setTimeout(() => {
      setSearchParams({ q: query.trim(), ids: idKey });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedIds]);

  async function loadMore() {
    void searchQuery.fetchNextPage();
  }

  function runSearch(nextQuery: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchParams({ q: nextQuery.trim(), ids: idKey });
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    // Explicit submit bypasses the debounce: run the search right away.
    runSearch(query);
  }

  function handleSuggestion(suggestion: string) {
    // A picked chip fills the input AND searches immediately (no debounce).
    startTransition(() => setQuery(suggestion));
    runSearch(suggestion);
  }

  async function handleExport(format: "csv" | "json") {
    setIsExporting(format);
    setError(null);
    try {
      // Backend caps top_k at 20 — export everything the user has loaded
      // (the full result count), not just the current page.
      const topK = Math.max(1, Math.min(totalCount, 20));
      await search.exportResults(query, format, selectedIds, topK);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(null);
    }
  }

  // Suggest example queries until a search returns results (or errors).
  const showSuggestions =
    hasSearched && !isLoading && !errorMessage && results.length === 0;

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
            onChange={(e) => startTransition(() => setQuery(e.target.value))}
            placeholder="Search your documents..."
            aria-label="Search your documents"
            className="search-input"
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

      {!hasSearched && !isLoading && (
        <EmptyState
          title="Search your documents"
          description="Find anything across your uploads in natural language — try one of these:"
          >
          <div className="search-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                onClick={() => handleSuggestion(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </EmptyState>
      )}

      <DocumentFilter selected={selectedIds} onChange={setSelectedIds} />

      {showSuggestions && hasSearched && (
        <SuggestionChips onPick={handleSuggestion} disabled={isLoading} />
      )}

      {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}

      {isLoading && <SearchSkeletons />}

      {!isLoading && hasSearched && results.length === 0 && !errorMessage && (
        <EmptyState
          title="No results found"
          description={`Nothing matched "${query}". Try different keywords.`}
          action={{ label: "Clear search", onClick: () => setQuery("") }}
        />
      )}

      {results.length > 0 && (
        <div className="search-results">
          <div className="search-results-header">
            <h2>Results ({totalCount})</h2>
            <div className="search-export-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleExport("csv")}
                disabled={isExporting !== null}
              >
                {isExporting === "csv" ? "Exporting…" : "Export CSV"}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleExport("json")}
                disabled={isExporting !== null}
              >
                {isExporting === "json" ? "Exporting…" : "Export JSON"}
              </button>
            </div>
          </div>
          <p className="search-status">
            Showing {results.length} of {totalCount} result{totalCount === 1 ? "" : "s"}
          </p>
          {results.map((result) => (
            <SearchResultCard
              key={result.chunk_id}
              result={result}
              query={query}
            />
          ))}
          {hasMore && (
            <div className="search-load-more">
              <span className="search-load-info">
                Loaded {results.length} of {totalCount}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadMore()}
                // Disabled while any fetch runs: a newer search in flight
                // (placeholder data from keepPreviousData) must not allow
                // page 2 of the old query to be merged onto page 1 of the
                // fresh one, and loading more pages is busy regardless.
                disabled={searchQuery.isFetching || isLoading}
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