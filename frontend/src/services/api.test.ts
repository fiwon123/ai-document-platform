import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statistics } from "./api";
import type { StatisticsResponse } from "../types";

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