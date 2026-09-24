import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_DOCUMENTS, DemoPage } from "./DemoPage";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));

const KEY_SEARCH = "askdocs-demo-searches";
const KEY_QA = "askdocs-demo-qa";

function renderDemo() {
  return render(
    <MemoryRouter>
      <DemoPage />
    </MemoryRouter>,
  );
}

async function runSearch(query: string) {
  fireEvent.change(screen.getByPlaceholderText("Search sample documents..."), {
    target: { value: query },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await act(async () => {});
}

async function askQuestion(question: string) {
  fireEvent.change(
    screen.getByPlaceholderText("Ask a question about the sample documents..."),
    { target: { value: question } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
}

describe("DemoPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("renders the demo banner, usage limits, and sample documents", () => {
    renderDemo();
    expect(
      screen.getByText(/Sign up to save your work and access more models/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to home" }).getAttribute("href"),
    ).toBe("/");
    for (const doc of DEMO_DOCUMENTS) {
      expect(screen.getByText(doc.filename)).toBeTruthy();
    }
    expect(screen.getByText(`${DEMO_DOCUMENTS.length} sample docs`)).toBeTruthy();
    expect(screen.getByText("10 searches left")).toBeTruthy();
    expect(screen.getByText("5 questions left")).toBeTruthy();
  });

  it("returns mock search results and decrements the session search counter", async () => {
    renderDemo();
    expect(screen.getByText("10 searches left")).toBeTruthy();

    await runSearch("benefits");

    expect(
      screen.getByText(/Review the full benefits catalog in Workday/i),
    ).toBeTruthy();
    expect(screen.getByText("Results (1)")).toBeTruthy();
    expect(screen.getByText("Score: 95.0%")).toBeTruthy();
    // The filename shows in the document card and in the result card header.
    expect(screen.getAllByText("company-handbook.pdf").length).toBeGreaterThan(1);
    expect(screen.getByText("9 searches left")).toBeTruthy();
    expect(window.sessionStorage.getItem(KEY_SEARCH)).toBe("1");
  });

  it("shows the sign-up CTA instead of searching when the search limit is reached", () => {
    window.sessionStorage.setItem(KEY_SEARCH, "10");
    renderDemo();

    const status = screen.getByRole("status");
    expect(within(status).getByText("You have reached the demo search limit.")).toBeTruthy();
    expect(
      within(status).getByRole("link", { name: "Sign up" }).getAttribute("href"),
    ).toBe("/register");
    expect(screen.getByPlaceholderText("Search sample documents...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  });

  it("renders a demo assistant answer with a source for a question", async () => {
    renderDemo();
    expect(screen.getByText("5 questions left")).toBeTruthy();

    await askQuestion("What benefits do employees get?");

    expect(screen.getByText("AskDocs demo")).toBeTruthy();
    expect(
      screen.getAllByText(/Answered by the demo assistant/i).length,
    ).toBeGreaterThan(0);
    // The matched source document is listed in the assistant message.
    expect(screen.getAllByText("company-handbook.pdf").length).toBeGreaterThan(1);
    expect(screen.getByText("4 questions left")).toBeTruthy();
    expect(window.sessionStorage.getItem(KEY_QA)).toBe("1");
  });

  it("shows the sign-up CTA instead of answering when the Q&A limit is reached", () => {
    window.sessionStorage.setItem(KEY_QA, "5");
    renderDemo();

    const status = screen.getByRole("status");
    expect(within(status).getByText("You have reached the demo Q&A limit.")).toBeTruthy();
    expect(
      within(status).getByRole("link", { name: "Sign up" }).getAttribute("href"),
    ).toBe("/register");
    expect(
      screen.getByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("counters live in sessionStorage only — never localStorage", async () => {
    renderDemo();

    await runSearch("onboarding");
    await askQuestion("What happens on day one?");

    expect(window.sessionStorage.getItem(KEY_SEARCH)).toBe("1");
    expect(window.sessionStorage.getItem(KEY_QA)).toBe("1");
    expect(window.localStorage.getItem(KEY_SEARCH)).toBeNull();
    expect(window.localStorage.getItem(KEY_QA)).toBeNull();
  });

  it("counters survive a reload (re-render) within the same session", () => {
    window.sessionStorage.setItem(KEY_SEARCH, "3");
    window.sessionStorage.setItem(KEY_QA, "2");

    const { unmount } = renderDemo();
    expect(screen.getByText("7 searches left")).toBeTruthy();
    expect(screen.getByText("3 questions left")).toBeTruthy();
    unmount();

    renderDemo();
    expect(screen.getByText("7 searches left")).toBeTruthy();
    expect(screen.getByText("3 questions left")).toBeTruthy();
  });
});