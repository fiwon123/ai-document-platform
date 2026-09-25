import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loaded subscriptions", async () => {
    renderWithClient(<WebhooksPage />);
    await settle();

    expect(screen.getByText("https://example.com/hook")).toBeInTheDocument();
    // The tutorial also mentions document.ready, so scope to the event tags.
    expect(
      screen.getByText("document.ready", { selector: ".webhook-event-tag" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("document.failed", { selector: ".webhook-event-tag" }),
    ).toBeInTheDocument();
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

  it("auto-expands the tutorial when there are no subscriptions", async () => {
    mockedList.mockResolvedValue([]);
    renderWithClient(<WebhooksPage />);
    await settle();

    const details = screen
      .getByText("How webhooks work")
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText(/Create a subscription/)).toBeTruthy();
  });

  it("keeps the tutorial collapsed once a subscription exists", async () => {
    renderWithClient(<WebhooksPage />);
    await settle();

    const details = screen
      .getByText("How webhooks work")
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // The summary stays visible so users can still open the card.
    expect(screen.getByText("How webhooks work")).toBeTruthy();
  });

  it("stays collapsed after a manual close even with zero subscriptions", async () => {
    mockedList.mockResolvedValue([]);
    renderWithClient(<WebhooksPage />);
    await settle();

    const details = screen
      .getByText("How webhooks work")
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);

    fireEvent.click(screen.getByText("How webhooks work"));
    await settle();
    expect(details.open).toBe(false);
  });

  it("expands and collapses the Python verification snippet", async () => {
    mockedList.mockResolvedValue([]);
    renderWithClient(<WebhooksPage />);
    await settle();

    const snippet = screen
      .getByText("Verify in Python (FastAPI / Flask)")
      .closest("details") as HTMLDetailsElement;
    expect(snippet.open).toBe(false);
    fireEvent.click(screen.getByText("Verify in Python (FastAPI / Flask)"));
    await settle();
    expect(snippet.open).toBe(true);
    expect(screen.getByText(/hmac\.new\(/)).toBeTruthy();
    expect(screen.getByText(/compare_digest/)).toBeTruthy();
  });

  it("shows the JavaScript verification snippet", async () => {
    mockedList.mockResolvedValue([]);
    renderWithClient(<WebhooksPage />);
    await settle();

    const snippet = screen
      .getByText("Verify in JavaScript (Node / Express)")
      .closest("details") as HTMLDetailsElement;
    fireEvent.click(screen.getByText("Verify in JavaScript (Node / Express)"));
    await settle();
    expect(snippet.open).toBe(true);
    expect(screen.getByText(/createHmac\("sha256"/)).toBeTruthy();
  });
});