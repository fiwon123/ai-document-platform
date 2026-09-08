import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QAPage } from "./QAPage";
import { documents, qa } from "../services/api";

vi.mock("../services/api", () => ({
  qa: { ask: vi.fn() },
  documents: { list: vi.fn() },
}));

const mockedAsk = vi.mocked(qa.ask);
const mockedList = vi.mocked(documents.list);

describe("QAPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockResolvedValue([]);
  });

  function ask(question: string, answer: string, model: string | null) {
    mockedAsk.mockResolvedValue({
      question,
      answer,
      sources: [],
      model,
    });
  }

  it("renders the user question, the answer, and the answering model", async () => {
    ask(
      "What is AskDocs?",
      "AskDocs is a document intelligence platform.",
      "gpt-4o-mini",
    );

    render(<QAPage />);

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "What is AskDocs?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("What is AskDocs?")).toBeInTheDocument();
    expect(
      await screen.findByText("AskDocs is a document intelligence platform."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Answered by gpt-4o-mini"),
    ).toBeInTheDocument();
  });

  it("omits the model badge when the model is null", async () => {
    ask("Hi", "Hello! How can I help?", null);

    render(<QAPage />);

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Hi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Hello! How can I help?")).toBeInTheDocument();
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
  });
});