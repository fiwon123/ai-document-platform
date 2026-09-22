import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";

vi.mock("../components/DocumentFilter", () => ({
  DocumentFilter: () => <div data-testid="document-filter" />,
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
  render(<SearchPage />);
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
});