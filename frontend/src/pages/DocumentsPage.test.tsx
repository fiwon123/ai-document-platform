import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls pending documents and updates the status badge", async () => {
    mockedList.mockResolvedValue([pendingDoc, readyDoc]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-pending",
      status: "ready",
      error_message: null,
      has_thumbnail: false,
    });

    render(<DocumentsPage />);
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

  it("fetches the thumbnail once polling reports the document has one", async () => {
    mockedList.mockResolvedValue([{ ...pendingDoc, id: "doc-new" }]);
    mockedGetStatus.mockResolvedValue({
      id: "doc-new",
      status: "ready",
      error_message: null,
      has_thumbnail: true,
    });
    mockedGetThumbnailUrl.mockResolvedValue({
      id: "doc-new",
      thumbnail_url: "https://minio.example/thumb.png",
    });

    const { container } = render(<DocumentsPage />);
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
    });

    render(<DocumentsPage />);
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

  it("does not poll when every document is in a final state", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    render(<DocumentsPage />);
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

    render(<DocumentsPage />);
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

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
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

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
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

    render(<DocumentsPage />);
    await settle();

    const previewButton = screen.getByRole("button", { name: "Preview" });
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

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await settle();

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("surfaces a preview error", async () => {
    mockedPreview.mockRejectedValue(new Error("Preview failed"));

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
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

    render(<DocumentsPage />);

    expect(await screen.findByAltText("Preview of report.pdf")).toHaveAttribute(
      "src",
      "https://minio.example/thumb.png",
    );
    expect(mockedGetThumbnailUrl).toHaveBeenCalledWith("doc-thumb");
  });

  it("keeps the generic placeholder for documents without a thumbnail", async () => {
    mockedList.mockResolvedValue([readyDoc]);

    const { container } = render(<DocumentsPage />);
    await settle();

    expect(mockedGetThumbnailUrl).not.toHaveBeenCalled();
    expect(container.querySelector(".document-thumbnail")).toBeNull();
    expect(container.querySelector(".file-icon")).toBeTruthy();
  });

  it("falls back to the placeholder when the thumbnail URL request fails", async () => {
    mockedList.mockResolvedValue([thumbDoc]);
    mockedGetThumbnailUrl.mockRejectedValue(new Error("not found"));

    const { container } = render(<DocumentsPage />);
    await settle();

    expect(mockedGetThumbnailUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".document-thumbnail")).toBeNull();
    expect(container.querySelector(".file-icon")).toBeTruthy();
  });

  it("retries a failed thumbnail lookup after the backoff window", async () => {
    vi.useFakeTimers();
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
          });
        }
        return Promise.resolve({
          id: "doc-b",
          status: "processing",
          error_message: null,
          has_thumbnail: false,
        });
      });
      mockedGetThumbnailUrl
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ id: "doc-a", thumbnail_url: "https://minio.example/thumb.png" });

      const { container } = render(<DocumentsPage />);
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

    const { container } = render(<DocumentsPage />);
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
      download_url: "https://example.com/download/notes.txt",
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("disables the row's delete button and shows a spinner while deleting", async () => {
    let resolveDelete!: () => void;
    mockedDelete.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // While the delete request is pending the button is disabled and shows a spinner.
    const busyButton = screen.getByRole("button", { name: /Deleting/ }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Deleting" })).toBeTruthy();

    await act(async () => {
      resolveDelete();
    });
    await settle();

    expect(mockedDelete).toHaveBeenCalledWith("doc-ready");
    expect(screen.queryByText("notes.txt")).toBeNull();
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

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    // While the download URL request is pending the button is disabled and shows a spinner.
    const busyButton = screen.getByRole("button", { name: /Downloading/ }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Downloading" })).toBeTruthy();

    await act(async () => {
      resolveDownload({
        id: "doc-ready",
        filename: "notes.txt",
        download_url: "https://example.com/download/notes.txt",
      });
    });
    await settle();

    expect(mockedGetDownloadUrl).toHaveBeenCalledWith("doc-ready");
    // The button returns to its idle state once the URL has been fetched.
    const idleButton = screen.getByRole("button", { name: "Download" }) as HTMLButtonElement;
    expect(idleButton.disabled).toBe(false);
  });

  it("dims and disables the dropzone while uploading", async () => {
    let resolveUpload!: (value: { uploaded: Document[]; failed: { filename: string; error: string }[] }) => void;
    mockedUploadMany.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );

    const { container } = render(<DocumentsPage />);
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

    const { container } = render(<DocumentsPage />);
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

    const { container } = render(<DocumentsPage />);
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

    const { container } = render(<DocumentsPage />);
    await settle();

    // 25 files > the 20-file per-request backend cap => 2 bulk requests.
    const files = Array.from({ length: 25 }, (_, i) => new File(["x"], `f${i}.txt`, { type: "text/plain" }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
    await settle();

    expect(mockedUploadMany).toHaveBeenCalledTimes(2);
    expect(mockedUploadMany.mock.calls[0][0]).toHaveLength(20);
    expect(mockedUploadMany.mock.calls[1][0]).toHaveLength(5);
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
    render(<DocumentsPage />);
    await settle();

    // The failed card has the button; the ready card does not.
    expect(screen.getByRole("button", { name: "Reprocess" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reprocess" })).toHaveLength(1);
  });

  it("re-enqueues the document, clears the error, and shows the pending badge", async () => {
    render(<DocumentsPage />);
    await settle();

    // The failed error is visible before reprocessing.
    expect(screen.getByText(/did not complete/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess" }));
    await settle();

    expect(mockedReprocess).toHaveBeenCalledWith("doc-failed");
    // The card switches to the pending badge and the error disappears.
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.queryByText(/did not complete/)).toBeNull();
  });

  it("shows a spinner and disables the button while reprocessing", async () => {
    let resolveReprocess!: (
      value: { message: string; document_id: string; status: string },
    ) => void;
    mockedReprocess.mockReturnValue(
      new Promise((resolve) => {
        resolveReprocess = resolve;
      }),
    );

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess" }));

    expect(
      (screen.getByRole("button", { name: /Reprocessing/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("status", { name: "Reprocessing" })).toBeTruthy();

    await act(async () => {
      resolveReprocess({
        message: "Document reprocessing started",
        document_id: "doc-failed",
        status: "pending",
      });
    });
    await settle();

    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("reports a reprocess failure and keeps the failed state", async () => {
    mockedReprocess.mockRejectedValue(new Error("already processing"));

    render(<DocumentsPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Reprocess" }));
    await settle();

    expect(screen.getByRole("alert")).toHaveTextContent("already processing");
    // The card stays failed with its original error message.
    expect(screen.getByText(/did not complete/)).toBeTruthy();
  });
});