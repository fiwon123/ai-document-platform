import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentFilter } from "./DocumentFilter";
import type { Document } from "../types";

const docs: Document[] = [
  {
    id: "doc-a",
    owner_id: "user-1",
    filename: "report.pdf",
    object_key: "k1",
    mime_type: "application/pdf",
    status: "ready",
    error_message: null,
    has_thumbnail: true,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "doc-b",
    owner_id: "user-1",
    filename: "notes.txt",
    object_key: "k2",
    mime_type: "text/plain",
    status: "failed",
    error_message: "No text content could be extracted",
    has_thumbnail: false,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:00Z",
  },
];

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

describe("DocumentFilter", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue(docs);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function renderFilter(selected: string[] = []) {
    const onChange = vi.fn();
    render(<DocumentFilter selected={selected} onChange={onChange} />);
    return onChange;
  }

  it("lists the user's documents", async () => {
    renderFilter();

    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByLabelText("All documents")).toBeTruthy();
  });

  it("reports a selected document via onChange", async () => {
    const onChange = renderFilter();

    fireEvent.click(await screen.findByLabelText("report.pdf"));

    expect(onChange).toHaveBeenCalledWith(["doc-a"]);
  });

  it("removes a document from the selection on second click", async () => {
    const onChange = renderFilter(["doc-a", "doc-b"]);

    fireEvent.click(await screen.findByLabelText("report.pdf"));

    expect(onChange).toHaveBeenCalledWith(["doc-b"]);
  });

  it("clears the selection when All documents is clicked", async () => {
    const onChange = renderFilter(["doc-a"]);

    fireEvent.click(await screen.findByLabelText("All documents"));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders nothing when the user has no documents", async () => {
    mockedList.mockResolvedValue([]);
    const { container } = render(<DocumentFilter selected={[]} onChange={vi.fn()} />);

    await act(async () => {});

    expect(container).toBeEmptyDOMElement();
  });
});