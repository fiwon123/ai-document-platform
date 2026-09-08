import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, documents, qa, search } from "./api";

describe("api client request paths", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should send documents.list to /v1/documents/ with skip/limit query params", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await documents.list(10, 50);

    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/documents/?skip=10&limit=50",
      expect.anything(),
    );
  });

  it("should use default skip=0 and limit=20 for documents.list", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await documents.list();

    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/documents/?skip=0&limit=20",
      expect.anything(),
    );
  });

  it("should send documents.get to /v1/documents/{id}", async () => {
    const doc = {
      id: "doc-1",
      owner_id: "user-1",
      filename: "test.pdf",
      object_key: "key",
      mime_type: "application/pdf",
      status: "ready",
      error_message: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(doc), { status: 200 }));

    await documents.get("doc-1");

    expect(mockFetch).toHaveBeenCalledWith("/v1/documents/doc-1", expect.anything());
  });

  it("should send documents.upload to /v1/documents/ with a POST and FormData body", async () => {
    const doc = {
      id: "doc-2",
      owner_id: "user-1",
      filename: "notes.txt",
      object_key: "key",
      mime_type: "text/plain",
      status: "pending",
      error_message: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(doc), { status: 201 }));

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await documents.upload(file);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/documents/");
    expect(options.method).toBe("POST");
    expect(options.body).toBeInstanceOf(FormData);
  });

  it("should send documents.delete to /v1/documents/{id} with DELETE", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "deleted" }), { status: 200 }),
    );

    await documents.delete("doc-3");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/documents/doc-3");
    expect(options.method).toBe("DELETE");
  });

  it("should send documents.getDownloadUrl to /v1/documents/{id}/download", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "doc-4",
          filename: "a.pdf",
          download_url: "http://localhost:9000/...",
        }),
        { status: 200 },
      ),
    );

    await documents.getDownloadUrl("doc-4");

    expect(mockFetch).toHaveBeenCalledWith(
      "/v1/documents/doc-4/download",
      expect.anything(),
    );
  });

  it("should send auth.login to /v1/auth/login with form-urlencoded body", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "token",
          token_type: "bearer",
          user: { id: "u1", username: "alice" },
        }),
        { status: 200 },
      ),
    );

    await auth.login("alice", "secret123");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/auth/login");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(options.body)).toContain("username=alice");
    expect(String(options.body)).toContain("password=secret123");
  });

  it("should send auth.register to /v1/auth/register with JSON body", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "u2", username: "bob", is_active: true, role: null, created_at: null }),
        { status: 200 },
      ),
    );

    await auth.register("bob", "password123", "password123");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/auth/register");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      username: "bob",
      password: "password123",
      confirm_password: "password123",
    });
  });

  it("should send auth.getMe to /v1/auth/me", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ id: "u1", username: "alice", is_active: true, role: null, created_at: null }),
        { status: 200 },
      ),
    );

    await auth.getMe();

    expect(mockFetch).toHaveBeenCalledWith("/v1/auth/me", expect.anything());
  });

  it("should send search.search to /v1/search/ with query and top_k", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ query: "q", results: [] }), { status: 200 }),
    );

    await search.search("quarterly report", 7);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/search/");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ query: "quarterly report", top_k: 7 });
  });

  it("should send qa.ask to /v1/qa/ask with question and document_ids", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ question: "q", answer: "a", sources: [] }), { status: 200 }),
    );

    await qa.ask("What is the refund policy?", ["doc-a", "doc-b"]);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("/v1/qa/ask");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      question: "What is the refund policy?",
      document_ids: ["doc-a", "doc-b"],
    });
  });

  it("should attach the Bearer token from localStorage", async () => {
    localStorage.setItem("token", "jwt-token-123");
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await documents.list();

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Authorization"]).toBe("Bearer jwt-token-123");
  });

  it("should throw ApiError with status and detail on error responses", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Not found" }), { status: 404 }),
    );

    await expect(documents.get("missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Not found",
    });
  });
});