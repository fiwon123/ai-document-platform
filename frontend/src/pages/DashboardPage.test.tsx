import { act, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import type { StatisticsResponse } from "../types";

const sampleStats: StatisticsResponse = {
  total_documents: 3,
  pending_documents: 1,
  processing_documents: 0,
  ready_documents: 2,
  failed_documents: 0,
  total_chunks: 12,
  recent_documents: [
    { id: "doc-1", filename: "guide.pdf", status: "ready", created_at: "2026-09-08T00:00:00Z" },
    { id: "doc-2", filename: "draft.md", status: "pending", created_at: "2026-09-07T00:00:00Z" },
  ],
};

vi.mock("../services/api", () => ({
  statistics: { getMe: vi.fn() },
}));

import { statistics } from "../services/api";

const mockedGetMe = vi.mocked(statistics.getMe);

describe("DashboardPage", () => {
  beforeEach(() => {
    mockedGetMe.mockResolvedValue(sampleStats);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function renderPage() {
    render(<DashboardPage />);
    await act(async () => {});
  }

  it("shows document and chunk totals from the statistics endpoint", async () => {
    await renderPage();

    expect(mockedGetMe).toHaveBeenCalled();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Chunks indexed")).toBeTruthy();
  });

  it("lists recently uploaded documents with status", async () => {
    await renderPage();

    expect(screen.getByText("guide.pdf")).toBeTruthy();
    expect(screen.getByText("draft.md")).toBeTruthy();
    // Ready/pending appear both in the stat cards and the recent rows.
    expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Pending").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the empty state when there are no documents", async () => {
    mockedGetMe.mockResolvedValue({
      ...sampleStats,
      total_documents: 0,
      ready_documents: 0,
      pending_documents: 0,
      total_chunks: 0,
      recent_documents: [],
    });

    await renderPage();

    expect(
      screen.getByText("No documents yet. Upload your first document to get started."),
    ).toBeTruthy();
  });
});