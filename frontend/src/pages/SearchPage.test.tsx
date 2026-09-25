import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";
import { renderWithClient } from "../test/renderWithClient";
import type { SearchResponse } from "../types";

vi.mock("../components/DocumentFilter", () => ({
  DocumentFilter: () => <div data-testid="document-filter" />,
}));

// Mutable URL-params holder: tests can seed params before render and the
// mock setter ("navigate") records/replaces them like the real router.
const urlParamsHolder = vi.hoisted(() => {
  const holder = {
    params: new URLSearchParams(),
    setParams: vi.fn((next: URLSearchParams) => {
      holder.params = next;
    }),
  };
  return holder;
});

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [urlParamsHolder.params, urlParamsHolder.setParams],
}));

vi.mock("../services/api", () => ({
  search: { search: vi.fn(), exportResults: vi.fn() },
}));

import { search } from "../services/api";

const mockedSearch = vi.mocked(search.search);
const mockedExportResults = vi.mocked(search.exportResults);

const result = {
  chunk_id: "c-1",
  document_id: "d-1",
  document_filename: "notes.txt",
  content: "meeting minutes about Q3 planning",
  score: 0.92,
  metadata_: null,
};

async function runSearch(query: string) {
  renderWithClient(<SearchPage />);
  fireEvent.change(screen.getByPlaceholderText("Search your documents..."), {
    target: { value: query },
  });
  fireEvent.click(screen.getByText("Search"));
  await act(async () => {});
}

function byFullText(text: string) {
  // getByText with a string cannot match text split across <mark>/<span>
  // children (query-term highlighting), so match on full textContent.
  return (_content: string, element: Element | null) =>
    element?.textContent === text;
}

describe("SearchPage", () => {
  beforeEach(() => {
    urlParamsHolder.params = new URLSearchParams();
    urlParamsHolder.setParams.mockClear();
    mockedSearch.mockResolvedValue({
      query: "",
      results: [result],
      total_count: 1,
      has_more: false,
    });
  });

  it("searches with the typed query and renders results", async () => {
    await runSearch("q3 planning");
    expect(mockedSearch).toHaveBeenCalledWith("q3 planning", 5, [], 0);
    expect(screen.getByText(byFullText("meeting minutes about Q3 planning"))).toBeTruthy();
    expect(screen.getByText("Results (1)")).toBeTruthy();
  });

  it("shows an error message when the search fails", async () => {
    mockedSearch.mockRejectedValue(new Error("Search backend unavailable"));
    await runSearch("anything");
    expect(screen.getByText("Search backend unavailable")).toBeTruthy();
  });

  it("keeps the search input enabled and focused while a search is in flight", async () => {
    let resolveSearch: (value: SearchResponse) => void = () => {};
    mockedSearch.mockReturnValue(
      new Promise<SearchResponse>((resolve) => {
        resolveSearch = resolve;
      }),
    );

    renderWithClient(<SearchPage />);
    const input = screen.getByPlaceholderText(
      "Search your documents...",
    ) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "q3 planning" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // The request is pending — the input must stay enabled and keep focus.
    // Regression test: it used to be disabled while loading, which made
    // browsers drop focus mid-typing ("search input keeps unfocusing").
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);

    await act(async () => {
      resolveSearch({
        query: "q3 planning",
        results: [result],
        total_count: 1,
        has_more: false,
      });
    });

    // Focus survives the search completing.
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("ignores stale responses when a newer search supersedes an in-flight one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const staleResponse: SearchResponse = {
        query: "first",
        results: [{ ...result, chunk_id: "c-stale", content: "stale content" }],
        total_count: 1,
        has_more: false,
      };
      const freshResponse: SearchResponse = {
        query: "fresh query",
        results: [{ ...result, chunk_id: "c-fresh", content: "fresh content" }],
        total_count: 1,
        has_more: false,
      };

      let resolveStale: (value: SearchResponse) => void = () => {};
      mockedSearch
        .mockReturnValueOnce(
          new Promise<SearchResponse>((resolve) => {
            resolveStale = resolve;
          }),
        )
        .mockResolvedValueOnce(freshResponse);

      renderWithClient(<SearchPage />);
      const input = screen.getByPlaceholderText("Search your documents...");

      // First keystroke starts a debounced search that stays pending.
      fireEvent.change(input, { target: { value: "first" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // User keeps typing; the newer debounced search resolves first.
      fireEvent.change(input, { target: { value: "fresh query" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByText(byFullText("fresh content"))).toBeTruthy();

      // The stale first response arrives late and must not overwrite results.
      await act(async () => {
        resolveStale(staleResponse);
      });

      expect(screen.getByText(byFullText("fresh content"))).toBeTruthy();
      expect(screen.queryByText(byFullText("stale content"))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards an in-flight search when the query is cleared", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      let resolveSearch: (value: SearchResponse) => void = () => {};
      mockedSearch.mockReturnValue(
        new Promise<SearchResponse>((resolve) => {
          resolveSearch = resolve;
        }),
      );

      renderWithClient(<SearchPage />);
      const input = screen.getByPlaceholderText("Search your documents...");

      // A debounced search fires and stays pending.
      fireEvent.change(input, { target: { value: "q3 planning" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // The user clears the query while the request is still in flight.
      fireEvent.change(input, { target: { value: "" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      // The late response must not repopulate results for an empty query.
      await act(async () => {
        resolveSearch({
          query: "q3 planning",
          results: [result],
          total_count: 1,
          has_more: false,
        });
      });

      expect(screen.queryByText("Results (1)")).toBeNull();
      expect(screen.queryByText(byFullText("meeting minutes about Q3 planning"))).toBeNull();
      // The cancelled request must not leave the loading state stuck: the
      // button text reverts from "Searching..." to "Search" (it stays
      // disabled because the query itself is empty now).
      expect(screen.queryByText("Searching…")).toBeNull();
      expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables load more while a newer search is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      mockedSearch
        .mockResolvedValueOnce({
          query: "first",
          results: [result],
          total_count: 3,
          has_more: true,
        })
        // The newer autosearch never resolves, keeping isLoading true.
        .mockReturnValue(new Promise<SearchResponse>(() => {}));

      renderWithClient(<SearchPage />);
      const input = screen.getByPlaceholderText("Search your documents...");
      fireEvent.change(input, { target: { value: "first" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      const loadMore = screen.getByRole("button", {
        name: "Load more results",
      });
      expect((loadMore as HTMLButtonElement).disabled).toBe(false);

      // Typing a new query starts an autosearch; while it is in flight the
      // load-more button must be disabled so page 2 of the new query can
      // never be merged onto page 1 of the old results.
      fireEvent.change(input, { target: { value: "second" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(
        (screen.getByRole("button", { name: "Load more results" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a styled empty state when no results match", async () => {
    mockedSearch.mockResolvedValue({
      query: "q3 planning",
      results: [],
      total_count: 0,
      has_more: false,
    });
    await runSearch("q3 planning");

    expect(screen.getByText("No results found")).toBeTruthy();
    expect(
      screen.getByText(
        'Nothing matched "q3 planning". Try different keywords.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText("No results found")).toBeNull();
  });

  it("loads more results when has_more is true", async () => {
    const firstPage = {
      query: "q3 planning",
      results: [result],
      total_count: 3,
      has_more: true,
    };
    const secondResult = {
      chunk_id: "c-2",
      document_id: "d-2",
      document_filename: "report.pdf",
      content: "Q3 planning notes",
      score: 0.31,
      metadata_: null,
    };
    const secondPage = {
      query: "q3 planning",
      results: [secondResult],
      total_count: 3,
      has_more: false,
    };
    mockedSearch
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    await runSearch("q3 planning");
    expect(screen.getByText("Results (3)")).toBeTruthy();

    const loadMore = screen.getByRole("button", { name: "Load more results" });
    fireEvent.click(loadMore);
    await act(async () => {});

    expect(mockedSearch).toHaveBeenLastCalledWith("q3 planning", 5, [], 1);
    expect(screen.getByText(byFullText("Q3 planning notes"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more results" })).toBeNull();
  });

  it("does not show a load-more button when has_more is false", async () => {
    await runSearch("q3 planning");
    expect(
      screen.queryByRole("button", { name: "Load more results" }),
    ).toBeNull();
  });

  it("exports results as CSV with the current query and filters", async () => {
    mockedExportResults.mockResolvedValue(undefined);
    await runSearch("q3 planning");

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await act(async () => {});

    // topK matches total_count (capped at the backend's 20) so the whole
    // result set is exported, not just the first page.
    expect(mockedExportResults).toHaveBeenCalledWith(
      "q3 planning",
      "csv",
      [],
      1,
    );
  });

  it("exports results as JSON with the current query and filters", async () => {
    mockedExportResults.mockResolvedValue(undefined);
    await runSearch("q3 planning");

    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await act(async () => {});

    expect(mockedExportResults).toHaveBeenCalledWith(
      "q3 planning",
      "json",
      [],
      1,
    );
  });

  it("shows an error when the export fails", async () => {
    mockedExportResults.mockRejectedValue(new Error("Export backend down"));
    await runSearch("q3 planning");

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await act(async () => {});

    expect(screen.getByText("Export backend down")).toBeTruthy();
  });

  it("shows suggestion chips before the first search and runs them instantly", async () => {
    renderWithClient(<SearchPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "How does document processing work?" }),
    );
    await act(async () => {});

    expect(mockedSearch).toHaveBeenCalledWith(
      "How does document processing work?",
      5,
      [],
      0,
    );
    // The mocked result renders (getAllByText: the snippet may be wrapped in
    // a single span when the query terms don't occur inside the content).
    expect(
      screen.getAllByText(byFullText("meeting minutes about Q3 planning"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps suggestions visible when a search returns no results", async () => {
    mockedSearch.mockResolvedValue({
      query: "nothing here",
      results: [],
      total_count: 0,
      has_more: false,
    });
    await runSearch("nothing here");

    expect(screen.getByText("No results found")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Which documents mention security?" }),
    ).toBeTruthy();
  });

  it("shows a status line with the loaded result counts", async () => {
    mockedSearch.mockResolvedValue({
      query: "q3 planning",
      results: [result],
      total_count: 3,
      has_more: true,
    });
    await runSearch("q3 planning");

    expect(screen.getByText("Showing 1 of 3 results")).toBeTruthy();
    expect(screen.getByText("Loaded 1 of 3")).toBeTruthy();
  });

  it("renders a match-percentage chip on result cards", async () => {
    await runSearch("q3 planning");
    expect(screen.getByText("8% match")).toBeTruthy();
  });

  it("shows skeleton placeholders while a search is pending", async () => {
    let resolveSearch: (value: SearchResponse) => void = () => {};
    mockedSearch.mockReturnValue(
      new Promise<SearchResponse>((resolve) => {
        resolveSearch = resolve;
      }),
    );

    renderWithClient(<SearchPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Search your documents..."),
      { target: { value: "q3 planning" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const skeletons = screen.getByRole("status", { name: "Searching" });
    expect(skeletons.querySelectorAll(".search-skeleton")).toHaveLength(3);

    await act(async () => {
      resolveSearch({
        query: "q3 planning",
        results: [result],
        total_count: 1,
        has_more: false,
      });
    });
    expect(screen.queryByRole("status", { name: "Searching" })).toBeNull();
  });

  it("shows the match-strength legend once results are on screen", async () => {
    await runSearch("q3 planning");
    expect(screen.getByText("Match strength:")).toBeTruthy();
    expect(screen.getByText(/strong 65%\+/)).toBeTruthy();
    expect(screen.getByText(/partial 35–64%/)).toBeTruthy();
    expect(screen.getByText(/weak below 35%/)).toBeTruthy();
  });

  it("colours the match chip by its score tone", async () => {
    await runSearch("q3 planning");
    // 0.92 distance → 8% similarity → the weak (red) tone.
    const chip = screen.getByText("8% match");
    expect(chip.className).toContain("tone-weak");
  });

  it("hydrates query and document scope from URL params on mount", async () => {
    mockedSearch.mockResolvedValue({
      query: "security",
      results: [result],
      total_count: 1,
      has_more: false,
    });
    urlParamsHolder.params = new URLSearchParams("q=security&doc=d-9");

    renderWithClient(<SearchPage />);
    await act(async () => {});

    expect(
      screen.getByPlaceholderText("Search your documents..."),
    ).toHaveValue("security");
    // The search fires immediately with the deep-linked scope.
    expect(mockedSearch).toHaveBeenCalledWith("security", 5, ["d-9"], 0);
  });

  it("mirrors the live search state back into the URL", async () => {
    await runSearch("q3 planning");
    expect(urlParamsHolder.setParams).toHaveBeenCalledWith(
      expect.any(URLSearchParams),
      { replace: true },
    );
    const written = urlParamsHolder.setParams.mock.calls.at(-1)?.[0] as URLSearchParams;
    expect(written.get("q")).toBe("q3 planning");
  });
});