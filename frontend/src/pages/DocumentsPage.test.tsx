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
  created_at: "2026-09-08T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
};

const readyDoc: Document = { ...pendingDoc, id: "doc-ready", filename: "notes.txt", status: "ready" };

vi.mock("../services/api", () => ({
  documents: {
    list: vi.fn(),
    getStatus: vi.fn(),
    upload: vi.fn(),
    delete: vi.fn(),
    getDownloadUrl: vi.fn(),
  },
}));

import { documents } from "../services/api";

const mockedList = vi.mocked(documents.list);
const mockedGetStatus = vi.mocked(documents.getStatus);
const mockedUpload = vi.mocked(documents.upload);
const mockedDelete = vi.mocked(documents.delete);
const mockedGetDownloadUrl = vi.mocked(documents.getDownloadUrl);

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
    mockedGetStatus.mockResolvedValue({ id: "doc-pending", status: "ready", error_message: null });

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

  it("stops polling once every document is ready", async () => {
    mockedList.mockResolvedValue([pendingDoc]);
    mockedGetStatus.mockResolvedValue({ id: "doc-pending", status: "ready", error_message: null });

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
    let resolveUpload!: (doc: Document) => void;
    mockedUpload.mockReturnValue(
      new Promise<Document>((resolve) => {
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
      resolveUpload({ ...readyDoc, id: "doc-new", filename: "guide.pdf" });
    });
    await settle();

    expect(mockedUpload).toHaveBeenCalledWith(file);
    expect(container.querySelector(".dropzone")?.classList.contains("is-uploading")).toBe(false);
    expect(screen.getByText("guide.pdf")).toBeTruthy();
  });
});