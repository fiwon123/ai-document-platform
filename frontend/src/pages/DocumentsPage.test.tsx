import { act, render, screen } from "@testing-library/react";
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
  },
}));

import { documents } from "../services/api";

const mockedList = vi.mocked(documents.list);
const mockedGetStatus = vi.mocked(documents.getStatus);

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
});