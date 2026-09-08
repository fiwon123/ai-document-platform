import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documents, search } from "./api";
import type { DocumentStatusResponse } from "../types";

describe("documents.getStatus", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.setItem("token", "test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("requests the status endpoint with auth header", async () => {
    const status: DocumentStatusResponse = {
      id: "doc-123",
      status: "ready",
      error_message: null,
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(status), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await documents.getStatus("doc-123");

    expect(result).toEqual(status);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/documents/doc-123/status");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("throws an ApiError with backend detail on failure", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "Document not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const error = await documents.getStatus("missing").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { status: number }).status).toBe(404);
    expect((error as Error).message).toBe("Document not found");
  });
});

describe("search.search", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    localStorage.setItem("token", "test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("sends document_ids when documents are selected", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ query: "hello", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await search.search("hello", 5, ["doc-a", "doc-b"]);

    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String(options?.body))).toEqual({
      query: "hello",
      top_k: 5,
      document_ids: ["doc-a", "doc-b"],
    });
  });

  it("sends document_ids as null when no documents are selected", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ query: "hello", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await search.search("hello");

    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String(options?.body))).toEqual({
      query: "hello",
      top_k: 5,
      document_ids: null,
    });
  });
});