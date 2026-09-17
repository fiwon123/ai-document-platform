import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { auth, documents, qa, search, statistics, users } from "./api";

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
          expires_in: 1800,
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
    expect(JSON.parse(options.body as string)).toEqual({
      query: "quarterly report",
      top_k: 7,
      document_ids: null,
    });
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
      model: null,
    });
  });

  it("should send qa.ask with the selected model when provided", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ question: "q", answer: "a", sources: [] }), { status: 200 }),
    );

    await qa.ask("What is the refund policy?", undefined, "gpt-4o-mini");

    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      question: "What is the refund policy?",
      document_ids: null,
      model: "gpt-4o-mini",
    });
  });

  it("should send qa.getModels to /v1/qa/models", async () => {
    const models = { free: ["gpt-4o-mini"], paid: ["gpt-4o", "gpt-4"] };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(models), { status: 200 }));

    const result = await qa.getModels();

    expect(mockFetch).toHaveBeenCalledWith("/v1/qa/models", expect.anything());
    expect(result).toEqual(models);
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

  it("should throw ApiError using the standardized error envelope", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "not_found", message: "Document not found" },
        }),
        { status: 404 },
      ),
    );

    await expect(documents.get("missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Document not found",
    });
  });
});import type { DocumentStatusResponse } from "../types";

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
});import type { StatisticsResponse } from "../types";

const sampleStats: StatisticsResponse = {
  total_documents: 3,
  pending_documents: 1,
  processing_documents: 0,
  ready_documents: 2,
  failed_documents: 0,
  total_chunks: 12,
  recent_documents: [
    {
      id: "doc-1",
      filename: "guide.pdf",
      status: "ready",
      created_at: "2026-09-08T00:00:00Z",
    },
  ],
};

describe("statistics.getMe", () => {
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

  it("requests the statistics endpoint with auth header", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(sampleStats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await statistics.getMe();

    expect(result).toEqual(sampleStats);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/statistics/me");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });
});
import type { User } from "../types";

describe("users.updateMe", () => {
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

  it("updates the username on /v1/users/me with the auth header", async () => {
    const updated: User = {
      id: "u-1",
      username: "alice_new",
      is_active: true,
      role: "customer",
      created_at: null,
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await users.updateMe({ username: "alice_new" });

    expect(result).toEqual(updated);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/users/me");
    expect(options?.method).toBe("PUT");
    expect(JSON.parse(String(options?.body))).toEqual({ username: "alice_new" });
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("sends confirm_password when changing the password", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "u-1", username: "alice", is_active: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await users.updateMe({ password: "new-password-123", confirmPassword: "new-password-123" });

    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse(String(options?.body))).toEqual({
      password: "new-password-123",
      confirm_password: "new-password-123",
    });
  });
});

describe("users admin methods", () => {
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

  it("lists users via GET /v1/users/", async () => {
    const usersPayload: User[] = [
      { id: "u-1", username: "alice", is_active: true, role: "customer", created_at: null },
    ];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(usersPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await users.listUsers();

    expect(result).toEqual(usersPayload);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/users/");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("patches a user role via PATCH /v1/users/{id}/role", async () => {
    const updated: User = { id: "u-1", username: "alice", is_active: true, role: "admin", created_at: null };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify(updated), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await users.updateUserRole("u-1", "admin");

    expect(result).toEqual(updated);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/users/u-1/role");
    expect(options?.method).toBe("PATCH");
    expect(JSON.parse(String(options?.body))).toEqual({ role: "admin" });
  });

  it("deletes a user via DELETE /v1/users/{id} and tolerates 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(users.deleteUser("u-2")).resolves.toBeUndefined();

    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/v1/users/u-2");
    expect(options?.method).toBe("DELETE");
  });
});
