import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPage } from "./SearchPage";

vi.mock("../components/DocumentFilter", () => ({
  DocumentFilter: () => <div data-testid="document-filter" />,
}));

vi.mock("../services/api", () => ({
  search: { search: vi.fn() },
}));

import { search } from "../services/api";

const mockedSearch = vi.mocked(search.search);

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

describe("SearchPage", () => {
  beforeEach(() => {
    mockedSearch.mockResolvedValue({
      query: "",
      results: [result],
    });
  });

  it("searches with the typed query and renders results", async () => {
    await runSearch("q3 planning");
    expect(mockedSearch).toHaveBeenCalledWith("q3 planning", 5, []);
    expect(screen.getByText("meeting minutes about Q3 planning")).toBeTruthy();
    expect(screen.getByText("Results (1)")).toBeTruthy();
  });

  it("shows an error message when the search fails", async () => {
    mockedSearch.mockRejectedValue(new Error("Search backend unavailable"));
    await runSearch("anything");
    expect(screen.getByText("Search backend unavailable")).toBeTruthy();
  });

  it("shows a styled empty state when no results match", async () => {
    mockedSearch.mockResolvedValue({ query: "q3 planning", results: [] });
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
});