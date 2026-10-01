import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";
import { renderWithClient } from "../test/renderWithClient";
import type { Document } from "../types";

const pendingDoc: Document = {
  id: "doc-pending",
  owner_id: "user-1",
  filename: "report.pdf",
  object_key: "users/user-1/documents/doc-pending/report.pdf",
  mime_type: "application/pdf",
  status: "pending",
  error_message: null,
  has_thumbnail: false,
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
};

const readyDoc: Document = { ...pendingDoc, id: "doc-ready", filename: "notes.txt", status: "ready" };

const thumbDoc: Document = {
  ...pendingDoc,
  id: "doc-thumb",
  filename: "report.pdf",
  status: "ready",
  has_thumbnail: true,
};

const failedDoc: Document = {
  ...pendingDoc,
  id: "doc-failed",
  filename: "broken.pdf",
  status: "failed",
  error_message: "Processing did not complete within the timeout",
};

vi.mock("../services/api", () => ({
  documents: {
    list: vi.fn(),
    getStatus: vi.fn(),
    upload: vi.fn(),
    uploadMany: vi.fn(),
    delete: vi.fn(),
    getDownloadUrl: vi.fn(),
    getThumbnailUrl: vi.fn(),
    preview: vi.fn(),
    reprocess: vi.fn(),
  },
}));

import { documents } from "../services/api";

const mockedList = vi.mocked(documents.list);
const mockedGetStatus = vi.mocked(documents.getStatus);
const mockedUploadMany = vi.mocked(documents.uploadMany);
const mockedDelete = vi.mocked(documents.delete);
const mockedGetDownloadUrl = vi.mocked(documents.getDownloadUrl);
const mockedGetThumbnailUrl = vi.mocked(documents.getThumbnailUrl);
const mockedPreview = vi.mocked(documents.preview);
const mockedReprocess = vi.mocked(documents.reprocess);

/** Flush pending microtasks inside act so React applies queued state updates. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DocumentsPage polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Advance the fake clock in base-period steps, settling between them.
   *
   * A single large jump does not work for the status poll: it fires the pending
   * timer, the async poll body then suspends on its request, the clock races to
   * the far end of the jump, and the timer the poll schedules on completion
   * lands in the past — so only the first poll of the sequence happens. Stepping
   * lets each poll finish and reschedule before the clock moves on, which is
   * also what happens in a real browser.
   */
  async function advanceBySteps(totalMs: number, stepMs = 3000) {
    let remaining = totalMs;
    while (remaining > 0) {
      const step = Math.min(stepMs, remaining);
      await act(async () => {
        vi.advanceTimersByTime(step);
      });
      await settle();
      remaining -= step;
    }
  }

  it("polls pending documents and updates the status badge", async () => {
    mockedList.mockResolvedValue([pendingDoc, readyDoc]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "ready",
      error_message: null,
      has_thumbnail: false,
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    // Initial render: one pending badge, one ready badge.
    expect(screen.getAllByText("ready").length).toBe(1);
    expect(screen.getByText("pending")).toBeTruthy();

    // Advance one poll interval; the pending badge becomes ready.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();

    expect(mockedGetStatus).toHaveBeenCalledWith("doc-pending");
    expect(screen.getAllByText("ready").length).toBe(2);
    expect(screen.queryByText("pending")).toBeNull();
  });

  it("shows a ticking elapsed label while a document is pending", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      { ...pendingDoc, updated_at: now },
      readyDoc,
    ]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "pending",
      error_message: null,
      has_thumbnail: false,
      created_at: now,
      updated_at: now,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    // The pending card shows a compact elapsed label; the ready card does not.
    expect(screen.getByTitle("pending for 0s")).toBeTruthy();

    // One poll later the label ticks forward (updated_at is unchanged, the
    // fake clock advanced, so elapsed grows).
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();

    expect(screen.getByTitle("pending for 3s")).toBeTruthy();
  });

  it("fetches the thumbnail once polling reports the document has one", async () => {
    mockedList.mockResolvedValue([{ ...pendingDoc, id: "doc-new" }]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-new",
      status: "ready",
      error_message: null,
      has_thumbnail: true,
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
    });
    mockedGetThumbnailUrl.mockResolvedValue({
      id: "doc-new",
      thumbnail_url: "https://minio.example/thumb.png",
    });

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    // Still processing: no thumbnail lookup happens yet.
    expect(mockedGetThumbnailUrl).not.toHaveBeenCalled();
    expect(container.querySelector(".document-thumbnail")).toBeNull();

    // The poll merges has_thumbnail=true, so the preview is fetched and
    // rendered without a full page reload.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    // Flush the poll merge, then the thumbnail fetch chain.
    await settle();
    await settle();

    expect(mockedGetThumbnailUrl).toHaveBeenCalledWith("doc-new");
    const img = container.querySelector(".document-thumbnail");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://minio.example/thumb.png");
  });

  it("stops polling once every document is ready", async () => {
    mockedList.mockResolvedValue([pendingDoc]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "ready",
      error_message: null,
      has_thumbnail: false,
      created_at: "2026-09-08T00:00:00Z",
      updated_at: "2026-09-08T00:00:00Z",
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();

    const callsAfterFirstPoll = mockedGetStatus.mock.calls.length;
    expect(callsAfterFirstPoll).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    await settle();

    // No further status requests after the document reached a final state.
    expect(mockedGetStatus.mock.calls.length).toBe(callsAfterFirstPoll);
  });

  it("backs off when a poll reports no change, instead of polling every 3s forever", async () => {
    const now = new Date().toISOString();
    // A document that never moves: every response is identical to the list.
    mockedList.mockResolvedValue([
      { ...pendingDoc, status: "processing", updated_at: now },
    ]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "processing",
      error_message: null,
      has_thumbnail: false,
      created_at: now,
      updated_at: now,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    const polledAt = async (ms: number) => {
      const before = mockedGetStatus.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
      await settle();
      return mockedGetStatus.mock.calls.length - before;
    };

    // Schedule is 3s, then 6s, then 12s, then 24s, then 30s (capped).
    // Poll times measured from mount: 3000, 9000, 21000, 45000.
    expect(await polledAt(3000)).toBe(1);
    expect(await polledAt(3000)).toBe(0); // 6s not yet due
    expect(await polledAt(3000)).toBe(1); // 9s
    expect(await polledAt(11_999)).toBe(0); // 20.999s
    expect(await polledAt(1)).toBe(1); // 21s
    expect(await polledAt(23_999)).toBe(0); // 44.999s
    expect(await polledAt(1)).toBe(1); // 45s

    // At the ceiling it holds 30s: a further 30s window is one poll, not ten.
    expect(await polledAt(29_999)).toBe(0);
    expect(await polledAt(1)).toBe(1);
    expect(await polledAt(29_999)).toBe(0);
    expect(await polledAt(1)).toBe(1);
  });

  it("resets a backed-off document to the base cadence as soon as it changes", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      { ...pendingDoc, status: "processing", updated_at: now },
    ]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "processing",
      error_message: null,
      has_thumbnail: false,
      created_at: now,
      updated_at: now,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    // Push it to the ceiling: 3s, 9s, 21s, 45s.
    await advanceBySteps(45_000);
    expect(mockedGetStatus).toHaveBeenCalledTimes(4);

    // Now it reports a change (a thumbnail appeared) while staying active.
    const changedAt = new Date(Date.now() + 1000).toISOString();
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "processing",
      error_message: null,
      has_thumbnail: true,
      created_at: now,
      updated_at: changedAt,
    });

    // Next due is 75s (45s + 30s). The change resets it to a 3s period, so the
    // following poll is 3s later — not 30s.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();
    const afterChange = mockedGetStatus.mock.calls.length;
    expect(afterChange).toBe(5);

    await act(async () => {
      vi.advanceTimersByTime(2999);
    });
    await settle();
    expect(mockedGetStatus.mock.calls.length).toBe(afterChange);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(mockedGetStatus.mock.calls.length).toBe(afterChange + 1);
  });

  it("gives a newly uploaded document the base cadence beside a backed-off one", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      { ...pendingDoc, id: "doc-stuck", status: "processing", updated_at: now },
    ]);
    mockedGetStatus.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        status: "processing" as const,
        error_message: null,
        has_thumbnail: false,
        created_at: now,
        updated_at: now,
      }),
    );
    mockedUploadMany.mockResolvedValue({
      uploaded: [{ ...pendingDoc, id: "doc-fresh" }],
      failed: [],
    });

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    // Back the first document all the way to the 30s ceiling.
    await advanceBySteps(45_000);
    expect(mockedGetStatus.mock.calls.length).toBe(4);

    // Upload a second document mid-session, as a user would.
    const file = new File(["hello"], "fresh.pdf", { type: "application/pdf" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await settle();

    const countFor = (id: string) =>
      mockedGetStatus.mock.calls.filter(([polled]) => polled === id).length;
    expect(countFor("doc-fresh")).toBe(0); // not polled yet

    // The fresh document is polled within the base period even though its
    // neighbour is at 30s — the scheduler wakes on the *soonest* due time.
    await advanceBySteps(3000);
    expect(countFor("doc-fresh")).toBe(1);
  });

  it("does not leave a superseded in-flight poll rescheduling itself forever", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      { ...pendingDoc, status: "processing", updated_at: now },
    ]);

    // The first poll's request is still in flight when the page changes under
    // it: its result must not schedule another timer, or that poll repeats
    // forever against a stale document set.
    let releaseFirst!: (value: {
      id: string;
      status: "processing";
      error_message: null;
      has_thumbnail: boolean;
      created_at: string;
      updated_at: string;
    }) => void;
    mockedGetStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );

    const { unmount } = renderWithClient(<DocumentsPage />);
    await settle();

    // Let the poll fire and hang on its request.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(mockedGetStatus).toHaveBeenCalledTimes(1);

    // Unmount, then let the abandoned request resolve.
    unmount();
    await act(async () => {
      releaseFirst({
        id: "doc-pending",
        status: "processing",
        error_message: null,
        has_thumbnail: false,
        created_at: now,
        updated_at: now,
      });
    });
    await settle();

    const callsAfterResolve = mockedGetStatus.mock.calls.length;

    // However long we wait, the abandoned poll must not wake up again.
    await advanceBySteps(120_000);
    expect(mockedGetStatus.mock.calls.length).toBe(callsAfterResolve);
  });

  it("keeps polling after a failed poll, backing off rather than stopping", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      { ...pendingDoc, status: "processing", updated_at: now },
    ]);
    mockedGetStatus.mockRejectedValue(new Error("network down"));

    renderWithClient(<DocumentsPage />);
    await settle();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(mockedGetStatus.mock.calls.length).toBe(1);

    // A failure is not progress, so the cadence backs off like an unchanged
    // poll — but the scheduler must still be alive for the next attempt.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    await settle();
    expect(mockedGetStatus.mock.calls.length).toBe(2);

    // And it recovers once the network does.
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "ready",
      error_message: null,
      has_thumbnail: false,
      created_at: now,
      updated_at: now,
    });
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    await settle();
    expect(mockedGetStatus.mock.calls.length).toBe(3);
    expect(screen.queryByText("processing")).toBeNull();
  });

  it("does not poll when every document is in a final state", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    renderWithClient(<DocumentsPage />);
    await settle();
    expect(screen.getAllByText("ready").length).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    await settle();

    expect(mockedGetStatus).not.toHaveBeenCalled();
  });

  it("shows the empty state with an upload CTA when there are no documents", async () => {
    mockedList.mockResolvedValue([]);

    renderWithClient(<DocumentsPage />);
    await settle();

    expect(screen.getByText("No documents uploaded yet")).toBeTruthy();
    expect(
      screen.getByText("Upload your first document above to start asking questions."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Upload a document" }),
    ).toBeTruthy();
  });
});

describe("DocumentsPage filter toolbar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const mixedDocs = [pendingDoc, readyDoc, failedDoc]; // report.pdf, notes.txt, broken.pdf

  it("filters the grid by filename as the user types", async () => {
    mockedList.mockResolvedValue(mixedDocs);

    renderWithClient(<DocumentsPage />);
    await settle();

    expect(screen.getByRole("heading", { name: "report.pdf" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "notes.txt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "broken.pdf" })).toBeTruthy();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documents by filename" }),
      { target: { value: "pdf" } },
    );
    await settle();

    expect(screen.getByRole("heading", { name: "report.pdf" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "broken.pdf" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "notes.txt" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Showing 2 of 3");
  });

  it("filters by status chip and shows counts on each chip", async () => {
    mockedList.mockResolvedValue(mixedDocs);

    renderWithClient(<DocumentsPage />);
    await settle();

    const failedChip = screen.getByRole("button", { name: /^Failed/ });
    expect(failedChip.textContent).toContain("1");
    expect(screen.getByRole("button", { name: /^All/ }).textContent).toContain("3");

    fireEvent.click(failedChip);
    await settle();

    expect(screen.getByRole("heading", { name: "broken.pdf" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "report.pdf" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "notes.txt" })).toBeNull();

    // Clicking the active chip again clears the filter.
    fireEvent.click(screen.getByRole("button", { name: /^Failed/ }));
    await settle();
    expect(screen.getByRole("heading", { name: "report.pdf" })).toBeTruthy();
  });

  it("combines filename search with a status filter", async () => {
    mockedList.mockResolvedValue(mixedDocs);

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documents by filename" }),
      { target: { value: "p" } },
    );
    // report.pdf (pending) and broken.pdf (failed) both match "p".
    fireEvent.click(screen.getByRole("button", { name: /^Pending/ }));
    await settle();

    expect(screen.getByRole("heading", { name: "report.pdf" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "broken.pdf" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "notes.txt" })).toBeNull();
  });

  it("shows the no-match state and clears filters from it", async () => {
    mockedList.mockResolvedValue(mixedDocs);

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documents by filename" }),
      { target: { value: "zzz" } },
    );
    await settle();

    expect(screen.getByText("No documents match your filters")).toBeTruthy();
    // Both the toolbar row and the empty-state CTA clear the filters —
    // either one empties the search box and the status chip.
    const clears = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clears.length).toBe(2);
    fireEvent.click(clears[1]!);
    await settle();

    expect(screen.getByRole("heading", { name: "report.pdf" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "notes.txt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "broken.pdf" })).toBeTruthy();
  });

  it("hides the status chip for statuses with no documents", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    renderWithClient(<DocumentsPage />);
    await settle();

    expect(screen.getByRole("button", { name: /^Ready/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Failed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Processing/ })).toBeNull();
  });
});

describe("DocumentsPage preview", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue([readyDoc]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("opens the preview modal with the extracted text", async () => {
    mockedPreview.mockResolvedValue({
      id: "doc-ready",
      filename: "notes.txt",
      preview: "hello from the document",
      truncated: false,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    await settle();

    expect(mockedPreview).toHaveBeenCalledWith("doc-ready");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByText("hello from the document")).toBeTruthy();
  });

  it("shows the truncation note for long previews", async () => {
    mockedPreview.mockResolvedValue({
      id: "doc-ready",
      filename: "notes.txt",
      preview: "short",
      truncated: true,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    await settle();

    expect(
      screen.getByText("Preview truncated to the first 5000 characters."),
    ).toBeTruthy();
  });

  it("moves focus into the modal on open and restores it on Escape", async () => {
    mockedPreview.mockResolvedValue({
      id: "doc-ready",
      filename: "notes.txt",
      preview: "x",
      truncated: false,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    const previewButton = screen.getByRole("button", { name: "Preview document" });
    // Simulate real browser behavior where clicking a button focuses it.
    previewButton.focus();
    fireEvent.click(previewButton);
    await settle();

    // Focus lands on the modal's Close button (first focusable inside).
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // Focus is restored to the closing trigger.
    expect(document.activeElement).toBe(previewButton);
  });

  it("closes the modal when the Close button is clicked", async () => {
    mockedPreview.mockResolvedValue({
      id: "doc-ready",
      filename: "notes.txt",
      preview: "x",
      truncated: false,
    });

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a preview error", async () => {
    mockedPreview.mockRejectedValue(new Error("Preview failed"));

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview document" }));
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("Preview failed");
  });
});

describe("DocumentsPage thumbnails", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and renders the thumbnail image when a document has one", async () => {
    mockedList.mockResolvedValue([thumbDoc]);
    mockedGetThumbnailUrl.mockResolvedValue({
      id: "doc-thumb",
      thumbnail_url: "https://minio.example/thumb.png",
    });

    renderWithClient(<DocumentsPage />);

    expect(await screen.findByAltText("Preview of report.pdf")).toHaveAttribute(
      "src",
      "https://minio.example/thumb.png",
    );
    expect(mockedGetThumbnailUrl).toHaveBeenCalledWith("doc-thumb");
  });

  it("keeps the generic placeholder for documents without a thumbnail", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    expect(mockedGetThumbnailUrl).not.toHaveBeenCalled();
    expect(container.querySelector(".document-thumbnail")).toBeNull();
    expect(container.querySelector(".file-icon")).toBeTruthy();
  });

  it("shows the file extension on the placeholder tile", async () => {
    mockedList.mockResolvedValue([pendingDoc]); // report.pdf

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    expect(container.querySelector(".file-icon")?.textContent).toBe("PDF");
  });

  it("falls back to FILE for dotless or long extensions", async () => {
    mockedList.mockResolvedValue([
      { ...pendingDoc, id: "doc-dotless", filename: "archive" },
      { ...pendingDoc, id: "doc-long", filename: "data.somethinglong" },
    ]);

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    const tiles = container.querySelectorAll(".file-icon");
    expect(tiles.length).toBe(2);
    expect(tiles[0]?.textContent).toBe("FILE");
    expect(tiles[1]?.textContent).toBe("FILE");
  });

  it("renders an indeterminate progress bar while processing", async () => {
    mockedList.mockResolvedValue([
      { ...pendingDoc, id: "doc-processing", status: "processing" },
    ]);

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    const track = container.querySelector(".progress-track");
    expect(track).toBeTruthy();
    expect(track?.querySelector(".progress-bar")).toBeTruthy();
  });

  it("omits the progress bar for non-processing documents", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    expect(container.querySelector(".progress-track")).toBeNull();
  });

  it("falls back to the placeholder when the thumbnail URL request fails", async () => {
    mockedList.mockResolvedValue([thumbDoc]);
    mockedGetThumbnailUrl.mockRejectedValue(new Error("not found"));

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    expect(mockedGetThumbnailUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".document-thumbnail")).toBeNull();
    expect(container.querySelector(".file-icon")).toBeTruthy();
  });

  it("retries a failed thumbnail lookup after the backoff window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      // doc-a finishes processing (has_thumbnail flips via polling); doc-b
      // keeps polling alive so the docs array keeps changing.
      const docA: Document = { ...pendingDoc, id: "doc-a", filename: "a.pdf", status: "processing" };
      const docB: Document = { ...pendingDoc, id: "doc-b", filename: "b.pdf", status: "processing" };
      mockedList.mockResolvedValue([docA, docB]);
      mockedGetStatus.mockImplementation((id: string) => {
        if (id === "doc-a") {
          return Promise.resolve({
            id: "doc-a",
            status: "ready",
            error_message: null,
            has_thumbnail: true,
            created_at: "2026-09-08T00:00:00Z",
            updated_at: "2026-09-08T00:00:00Z",
          });
        }
        return Promise.resolve({
          id: "doc-b",
          status: "processing",
          error_message: null,
          has_thumbnail: false,
          created_at: "2026-09-08T00:00:00Z",
          updated_at: "2026-09-08T00:00:00Z",
        });
      });
      mockedGetThumbnailUrl
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ id: "doc-a", thumbnail_url: "https://minio.example/thumb.png" });

      const { container } = renderWithClient(<DocumentsPage />);
      await settle();

      // First poll: doc-a becomes ready with a thumbnail, but the lookup fails.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await settle();

      expect(mockedGetThumbnailUrl).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".document-thumbnail")).toBeNull();

      // While doc-b keeps polling, the failed lookup is retried once the
      // 30 s backoff has elapsed and the image appears.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await settle();

      expect(mockedGetThumbnailUrl).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".document-thumbnail")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the placeholder when the thumbnail image fails to load", async () => {
    mockedList.mockResolvedValue([thumbDoc]);
    mockedGetThumbnailUrl.mockResolvedValue({
      id: "doc-thumb",
      thumbnail_url: "https://minio.example/thumb.png",
    });

    const { container } = renderWithClient(<DocumentsPage />);
    const img = await screen.findByAltText("Preview of report.pdf");
    expect(container.querySelector(".document-thumbnail")).not.toBeNull();

    fireEvent.error(img);

    expect(container.querySelector(".document-thumbnail")).toBeNull();
    expect(container.querySelector(".file-icon")).toBeTruthy();
  });
});

describe("DocumentsPage busy states", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue([readyDoc]);
    mockedDelete.mockResolvedValue(undefined);
    mockedGetDownloadUrl.mockResolvedValue({
      id: "doc-ready",
      filename: "notes.txt",
      download_url: "/v1/documents/doc-ready/content?kind=original&token=abc",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("optimistically removes the document while the delete request is pending", async () => {
    let resolveDelete!: () => void;
    mockedDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    renderWithClient(<DocumentsPage />);
    await settle();

    // The ready card and its delete button are visible before the click.
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));

    // Optimistic deletion: the card disappears immediately, before the
    // request settles.
    expect(mockedDelete).toHaveBeenCalledWith("doc-ready");
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getByText("No documents uploaded yet")).toBeTruthy();

    await act(async () => {
      resolveDelete();
    });
    await settle();

    // The document stays gone once the delete request has completed.
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("restores the document when the delete request fails", async () => {
    let rejectDelete!: (error: Error) => void;
    mockedDelete.mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectDelete = reject;
      }),
    );

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await settle();

    // The card was removed optimistically while the request was pending.
    expect(screen.queryByText("notes.txt")).toBeNull();

    await act(async () => {
      rejectDelete(new Error("Delete failed"));
    });
    await settle();

    // The optimistic removal rolls back and the card returns with the error.
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("Delete failed");
  });

  it("disables the row's download button and shows a spinner while fetching the URL", async () => {
    let resolveDownload!: (value: {
      id: string;
      filename: string;
      download_url: string;
    }) => void;
    mockedGetDownloadUrl.mockReturnValue(
      new Promise((resolve) => {
        resolveDownload = resolve;
      }),
    );

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Download document" }));

    // While the download URL request is pending the button is disabled and shows a spinner.
    const busyButton = screen.getByRole("button", { name: "Download document" }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Downloading" })).toBeTruthy();

    await act(async () => {
      resolveDownload({
        id: "doc-ready",
        filename: "notes.txt",
        download_url: "/v1/documents/doc-ready/content?kind=original&token=abc",
      });
    });
    await settle();

    expect(mockedGetDownloadUrl).toHaveBeenCalledWith("doc-ready");
    // The button returns to its idle state once the URL has been fetched.
    const idleButton = screen.getByRole("button", { name: "Download document" }) as HTMLButtonElement;
    expect(idleButton.disabled).toBe(false);
  });

  it("dims and disables the dropzone while uploading", async () => {
    let resolveUpload!: (value: { uploaded: Document[]; failed: { filename: string; error: string }[] }) => void;
    mockedUploadMany.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    const file = new File(["hello world"], "guide.pdf", { type: "application/pdf" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    const dropzone = container.querySelector(".dropzone") as HTMLElement;
    expect(dropzone.classList.contains("is-uploading")).toBe(true);
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Uploading…")).toBeTruthy();

    await act(async () => {
      resolveUpload({
        uploaded: [{ ...readyDoc, id: "doc-new", filename: "guide.pdf" }],
        failed: [],
      });
    });
    await settle();

    expect(mockedUploadMany).toHaveBeenCalledWith([file]);
    expect(container.querySelector(".dropzone")?.classList.contains("is-uploading")).toBe(false);
    expect(screen.getByText("guide.pdf")).toBeTruthy();
  });

  it("prepends all successfully uploaded documents from a bulk response", async () => {
    mockedUploadMany.mockResolvedValue({
      uploaded: [
        { ...readyDoc, id: "doc-a", filename: "a.txt" },
        { ...readyDoc, id: "doc-b", filename: "b.txt" },
      ],
      failed: [],
    });

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileA, fileB] } });
    await settle();

    expect(mockedUploadMany).toHaveBeenCalledWith([fileA, fileB]);
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(screen.getByText("b.txt")).toBeTruthy();
  });

  it("reports per-file failures while still showing successful uploads", async () => {
    mockedUploadMany.mockResolvedValue({
      uploaded: [{ ...readyDoc, id: "doc-ok", filename: "ok.txt" }],
      failed: [{ filename: "virus.exe", error: "Unsupported file type." }],
    });

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    const fileOk = new File(["ok"], "ok.txt", { type: "text/plain" });
    const fileBad = new File(["bad"], "virus.exe", { type: "application/octet-stream" });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileOk, fileBad] } });
    await settle();

    // Successful file appears in the list; the failed one is surfaced as an alert.
    expect(screen.getByText("ok.txt")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent(
      'Upload of "virus.exe" failed: Unsupported file type.',
    );
    expect(screen.queryByText("virus.exe")).toBeNull();
  });

  it("splits batches larger than the backend limit into multiple requests", async () => {
    // Each resolved batch echoes its own files as successfully uploaded.
    mockedUploadMany.mockImplementation(async (batch) => ({
      uploaded: batch.map((f) => ({ ...readyDoc, id: `doc-${f.name}`, filename: f.name })),
      failed: [],
    }));

    const { container } = renderWithClient(<DocumentsPage />);
    await settle();

    // 25 files > the 20-file per-request backend cap => 2 bulk requests.
    const files = Array.from({ length: 25 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
    await settle();

    expect(mockedUploadMany).toHaveBeenCalledTimes(2);
    expect(mockedUploadMany.mock.calls[0]![0]).toHaveLength(20);
    expect(mockedUploadMany.mock.calls[1]![0]).toHaveLength(5);
    // Results from both batches are merged into the document list.
    expect(screen.getByText("f0.txt")).toBeTruthy();
    expect(screen.getByText("f24.txt")).toBeTruthy();
  });
});

describe("DocumentsPage reprocess", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue([failedDoc, readyDoc]);
    mockedReprocess.mockResolvedValue({
      message: "Document reprocessing started",
      document_id: "doc-failed",
      status: "pending",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows a Reprocess button only for failed documents", async () => {
    renderWithClient(<DocumentsPage />);
    await settle();

    // The failed card has the button; the ready card does not.
    expect(screen.getByRole("button", { name: "Reprocess document" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reprocess document" })).toHaveLength(1);
  });

  it("re-enqueues the document, clears the error, and shows the pending badge", async () => {
    renderWithClient(<DocumentsPage />);
    await settle();

    // The failed error is visible before reprocessing.
    expect(screen.getByText(/did not complete/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess document" }));
    await settle();

    expect(mockedReprocess).toHaveBeenCalledWith("doc-failed");
    // The card switches to the pending badge and the error disappears.
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText(/did not complete/)).toBeNull();
  });

  it("optimistically flips the failed card to pending while the request is in flight", async () => {
    let resolveReprocess!: (
      value: { message: string; document_id: string; status: string },
    ) => void;
    mockedReprocess.mockReturnValue(
      new Promise((resolve) => {
        resolveReprocess = resolve;
      }),
    );

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess document" }));
    await settle();

    // Optimistic: the card immediately shows the pending badge and the
    // failure message clears, before the request has resolved.
    expect(mockedReprocess).toHaveBeenCalledWith("doc-failed");
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText(/did not complete/)).toBeNull();

    await act(async () => {
      resolveReprocess({
        message: "Document reprocessing started",
        document_id: "doc-failed",
        status: "pending",
      });
    });
    await settle();

    // The card stays pending once the request has completed.
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText(/did not complete/)).toBeNull();
  });

  it("rolls back to the failed state when reprocessing fails", async () => {
    mockedReprocess.mockRejectedValue(new Error("already processing"));

    renderWithClient(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess document" }));
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("already processing");
    // The optimistic flip rolls back: the card stays failed with its
    // original error message and its Reprocess button.
    expect(screen.getByText(/did not complete/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reprocess document" })).toBeTruthy();
  });
});