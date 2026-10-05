import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  it("reports when a test ping was sent, next to the button that sent it (#588)", async () => {
    /* The result used to be a bare "Test: Delivered" with no time, sitting
       above the button row while the card's own "Last delivered" entry updated
       on a different schedule. Undated, the two read as a contradiction
       instead of as two separate events. */
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

    const result = screen.getByRole("status");
    expect(result).toHaveTextContent(/^Test sent \d/);
    expect(result).toHaveTextContent("Delivered");

    /* Inline with the action row, not stranded above it. */
    expect(result.closest(".webhook-actions")).not.toBeNull();

    /* And the time is a real clock reading, not a placeholder. */
    const shown = Number(result.textContent?.match(/Test sent (\d{1,2}):(\d{2})/)![2]);
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(shown).toBeLessThanOrEqual(59);
  });

  it("orders the result directly after Send test, not at the far right of the row (#588)", async () => {
    /* First pass right-aligned the result with `margin-left: auto`, which put it
       ~378px from Send test with nothing in between, so row membership was the
       only thing tying a result to the button that produced it. Assert the
       sibling order, because that is what the fix actually changed. */
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

    const actions = screen.getByRole("status").closest(".webhook-actions")!;
    const kids = [...actions.children];
    const resultIdx = kids.indexOf(screen.getByRole("status"));
    const sendIdx = kids.findIndex((el) =>
      (el as HTMLElement).textContent?.includes("Send test"),
    );
    const deleteIdx = kids.findIndex((el) => (el as HTMLElement).textContent?.includes("Delete"));
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBe(sendIdx + 1);
    expect(deleteIdx).toBeGreaterThan(resultIdx);
  });

  it("does not right-align the result away from its own button (#588)", () => {
    /* The order assertion above passes whichever way the result is laid out in
       CSS — sibling order is the markup, this is the alignment. Right-aligned
       with `margin-left: auto` the result sat ~378px from Send test, which is
       the exact defect the ordering was meant to remove, so the margin itself
       needs to be pinned. */
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const block = css.match(/\.webhook-test-result\s*\{([^}]*)\}/);
    expect(block?.[1]).not.toMatch(/margin-left:\s*auto/);
  });

  it("separates the time from the message with a glyph, not whitespace (#588)", () => {
    /* Two spans with only a flex gap between them rendered as "3:47:03 AM  HTTP
       405", which reads as two unrelated items. The glyph is CSS ::after, so it
       never appears in the DOM text — this has to read the stylesheet. */
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).toMatch(
      /\.webhook-test-result-time::after\s*\{[^}]*content:\s*"·"/,
    );
  });

  it("keeps the tutorial callout on the same measure as the cards (#588)", () => {
    /* The callout is a banner rather than a card, but left at its own 640px it
       ended 220px short of the column the cards below it use — the only element
       on the page that did not fill the measure. */
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).toMatch(/\.page-column--wide \.webhook-tutorial\s*\{\s*max-width:\s*none/);
  });

  it("centres its content in a wider column than the settings form (#588)", () => {
    renderWithClient(<WebhooksPage />);
    expect(document.querySelector(".page.page-column.page-column--wide")).not.toBeNull();
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
    // The snippet is now tokenized into colored spans — assert on the text
    // content of the code element rather than exact-text matching.
    const code = snippet.querySelector("pre code");
    expect(code?.textContent).toMatch(/hmac\.new\(/);
    expect(code?.textContent).toMatch(/compare_digest/);
    expect(snippet.querySelector(".tok-keyword")?.textContent).toBe("import");
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
    const code = snippet.querySelector("pre code");
    expect(code?.textContent).toContain('createHmac("sha256"');
    expect(code?.textContent).toContain("timingSafeEqual");
  });
});