import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksPage } from "./WebhooksPage";
import { renderWithClient } from "../test/renderWithClient";
import type { WebhookSubscription } from "../types";

const readySub: WebhookSubscription = {
  id: "wh-1",
  url: "https://example.com/hook",
  events: ["document.ready", "document.failed"],
  is_active: true,
  secret: "test-secret-123",
  last_status: "success",
  last_status_code: 200,
  last_delivered_at: "2026-09-23T10:00:00Z",
  failure_count: 0,
  created_at: "2026-09-22T10:00:00Z",
  updated_at: "2026-09-23T10:00:00Z",
};

vi.mock("../services/api", () => ({
  webhooks: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}));

import { webhooks } from "../services/api";

const mockedList = vi.mocked(webhooks.list);
const mockedCreate = vi.mocked(webhooks.create);
const mockedUpdate = vi.mocked(webhooks.update);
const mockedRemove = vi.mocked(webhooks.remove);
const mockedTest = vi.mocked(webhooks.test);

/** Flush pending microtasks inside act so React applies queued state updates. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("WebhooksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([readySub]);
  });

  it("renders the loaded subscriptions", async () => {
    renderWithClient(<WebhooksPage />);
    await settle();

    expect(screen.getByText("https://example.com/hook")).toBeInTheDocument();
    expect(screen.getByText("document.ready")).toBeInTheDocument();
    expect(screen.getByText("document.failed")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("creates a webhook with the chosen URL and events", async () => {
    mockedCreate.mockResolvedValue({
      ...readySub,
      id: "wh-2",
      url: "https://new.example.com/hook",
      events: ["document.deleted"],
    });
    renderWithClient(<WebhooksPage />);
    await settle();

    fireEvent.change(screen.getByPlaceholderText("https://example.com/hook"), {
      target: { value: "https://new.example.com/hook" },
    });
    fireEvent.click(screen.getByLabelText("Document deleted"));
    fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));
    await settle();

    expect(mockedCreate).toHaveBeenCalledWith("https://new.example.com/hook", [
      "document.ready",
      "document.deleted",
    ]);
    expect(screen.getByText("https://new.example.com/hook")).toBeInTheDocument();
  });

  it("rejects creation when no URL is provided", async () => {
    renderWithClient(<WebhooksPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));
    await settle();

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the receiver URL.")).toBeInTheDocument();
  });

  it("pauses and resumes a subscription", async () => {
    mockedUpdate.mockResolvedValue({ ...readySub, is_active: false });
    renderWithClient(<WebhooksPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await settle();

    expect(mockedUpdate).toHaveBeenCalledWith("wh-1", { is_active: false });
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("sends a test ping and shows the result", async () => {
    mockedTest.mockResolvedValue({
      delivered: true,
      event: "ping",
      status_code: 200,
      message: "Delivered",
    });
    renderWithClient(<WebhooksPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await settle();

    expect(mockedTest).toHaveBeenCalledWith("wh-1");
    expect(screen.getByText(/Test: Delivered/)).toBeInTheDocument();
  });

  it("deletes a subscription", async () => {
    mockedRemove.mockResolvedValue(undefined);
    renderWithClient(<WebhooksPage />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await settle();

    expect(mockedRemove).toHaveBeenCalledWith("wh-1");
    expect(
      screen.queryByText("https://example.com/hook"),
    ).not.toBeInTheDocument();
  });
});