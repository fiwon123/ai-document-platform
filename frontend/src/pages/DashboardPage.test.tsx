import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { renderWithClient } from "../test/renderWithClient";
import { ToastProvider } from "../context/ToastProvider";
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
  documents: {
    preview: vi.fn(),
    getDownloadUrl: vi.fn(),
    reprocess: vi.fn(),
  },
}));

import { documents, statistics } from "../services/api";

const mockedGetMe = vi.mocked(statistics.getMe);
const mockedPreview = vi.mocked(documents.preview);
const mockedGetDownloadUrl = vi.mocked(documents.getDownloadUrl);
const mockedReprocess = vi.mocked(documents.reprocess);

describe("DashboardPage", () => {
  beforeEach(() => {
    mockedGetMe.mockResolvedValue(sampleStats);
    mockedPreview.mockResolvedValue({
      id: "doc-1",
      filename: "guide.pdf",
      preview: "first page text",
      truncated: false,
    });
    mockedGetDownloadUrl.mockResolvedValue({
      id: "doc-1",
      filename: "guide.pdf",
      download_url: "/v1/documents/doc-1/content?kind=original&token=abc",
    });
    mockedReprocess.mockResolvedValue({
      message: "Document reprocessing started",
      document_id: "doc-9",
      status: "pending",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function renderPage() {
    renderWithClient(
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>,
    );
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

    expect(screen.getByText("No documents yet")).toBeTruthy();
    expect(screen.getByText("Upload your first document to get started.")).toBeTruthy();
    const uploadLink = screen.getByRole("link", { name: "Upload a document" });
    expect(uploadLink).toHaveAttribute("href", "/app/documents");
  });

  it("renders quick actions linking to documents, search and qa", async () => {
    await renderPage();

    const upload = screen.getByRole("link", { name: /Upload document/ });
    expect(upload).toHaveAttribute("href", "/app/documents");
    expect(screen.getByRole("link", { name: /Search documents/ })).toHaveAttribute(
      "href",
      "/app/search",
    );
    expect(screen.getByRole("link", { name: /Ask a question/ })).toHaveAttribute("href", "/app/qa");
  });

  it("renders skeleton placeholders while statistics load", () => {
    mockedGetMe.mockReturnValue(new Promise(() => {}));

    renderWithClient(
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(screen.getByRole("status", { name: "Loading dashboard" })).toBeTruthy();
  });

  it("renders status-toned initial tiles for recent documents", async () => {
    const { container } = renderWithClient(
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>,
    );
    await act(async () => {});

    const tiles = container.querySelectorAll(".recent-tile");
    expect(tiles.length).toBe(2);
    expect(tiles[0]?.textContent).toBe("G"); // guide.pdf → ready → green
    expect(tiles[0]?.classList.contains("tone-green")).toBe(true);
    expect(tiles[1]?.textContent).toBe("D"); // draft.md → pending → amber
    expect(tiles[1]?.classList.contains("tone-amber")).toBe(true);
  });

  it("links recent filenames and the section to the documents page", async () => {
    await renderPage();

    expect(screen.getByRole("link", { name: "guide.pdf" })).toHaveAttribute(
      "href",
      "/app/documents",
    );
    expect(screen.getByRole("link", { name: /View all documents/ })).toHaveAttribute(
      "href",
      "/app/documents",
    );
  });

  it("shows progress + elapsed time for pending/processing uploads", async () => {
    const { container } = renderWithClient(
      <ToastProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ToastProvider>,
    );
    await act(async () => {});

    const progressTracks = container.querySelectorAll(".recent-item .progress-track");
    // Only draft.md is pending in the fixture.
    expect(progressTracks.length).toBe(1);
  });

  it("previews a ready document from the recent actions", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Preview guide.pdf" }));
    await act(async () => {});
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
    expect(screen.getByText("first page text")).toBeTruthy();
    expect(mockedPreview).toHaveBeenCalledWith("doc-1");
  });

  it("downloads a ready document from the recent actions", async () => {
    const user = userEvent.setup();
    await renderPage();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await user.click(screen.getByRole("button", { name: "Download guide.pdf" }));
    await act(async () => {});
    await waitFor(() => expect(mockedGetDownloadUrl).toHaveBeenCalledWith("doc-1"));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("retries a failed document from the recent actions", async () => {
    mockedGetMe.mockResolvedValue({
      ...sampleStats,
      failed_documents: 1,
      ready_documents: 1,
      pending_documents: 0,
      recent_documents: [
        {
          id: "doc-9",
          filename: "broken.pdf",
          status: "failed",
          created_at: "2026-09-06T00:00:00Z",
        },
      ],
    });
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole("button", { name: "Retry broken.pdf" }));
    await act(async () => {});
    await waitFor(() => expect(mockedReprocess).toHaveBeenCalledWith("doc-9"));
  });

  it("refetches the summary when the dashboard remounts (fresh uploads show up)", async () => {
    // One shared QueryClient: a second mount must observe the cached query
    // and refetch it (refetchOnMount: "always") instead of serving the
    // stale statistics from the previous visit.
    const { createTestQueryClient } = await import("../test/renderWithClient");
    const client = createTestQueryClient();
    const ui = (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );
    const { unmount } = render(ui);
    await act(async () => {});
    expect(mockedGetMe).toHaveBeenCalledTimes(1);

    unmount();
    render(ui);
    await act(async () => {});
    expect(mockedGetMe).toHaveBeenCalledTimes(2);
  });

  it("polls for fresh statistics while a recent document is still pending", async () => {
    vi.useFakeTimers();
    try {
      const { renderWithClient: renderShared } = await import("../test/renderWithClient");
      renderShared(
        <ToastProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </ToastProvider>,
      );
      await act(async () => {});
      expect(mockedGetMe).toHaveBeenCalledTimes(1);

      // draft.md is pending → the summary refetches on the 3s cadence so
      // the recent list flips pending → ready without a page reload.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(mockedGetMe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
