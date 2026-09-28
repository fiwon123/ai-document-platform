import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { QAPage } from "./QAPage";
import { renderWithClient } from "../test/renderWithClient";
import { documents, qa } from "../services/api";
import type { QAResponse } from "../types";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../services/api", () => ({
  qa: { ask: vi.fn(), getModels: vi.fn() },
  documents: { list: vi.fn() },
}));

const mockedAsk = vi.mocked(qa.ask);
const mockedList = vi.mocked(documents.list);
const mockedGetModels = vi.mocked(qa.getModels);

/** Matches full textContent — needed when the preview is split into
 *  <mark>/<span> children by query-term highlighting. */
function byFullText(text: string) {
  return (_content: string, element: Element | null) =>
    element?.textContent === text;
}

function ask(
  question: string,
  answer: string,
  model: string | null,
  sources: QAResponse["sources"] = [],
  mode: QAResponse["mode"] = "semantic",
) {
  mockedAsk.mockResolvedValue({
    question,
    answer,
    sources,
    model,
    mode,
  });
}

async function askQuestion(question: string) {
  renderWithClient(<QAPage />);
  fireEvent.change(
    screen.getByPlaceholderText("Ask a question about your documents..."),
    { target: { value: question } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
}

describe("QAPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("askdocs-model");
    mockedList.mockResolvedValue([]);
    mockedGetModels.mockResolvedValue({ free: [], paid: [] });
  });

  it("renders the user question, the answer, and the answering model", async () => {
    ask(
      "What is AskDocs?",
      "AskDocs is a document intelligence platform.",
      "gpt-4o-mini",
    );

    renderWithClient(<QAPage />);

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

    renderWithClient(<QAPage />);

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Hi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Hello! How can I help?")).toBeInTheDocument();
    expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
  });

  it("shows an empty state before any question is asked", () => {
    renderWithClient(<QAPage />);
    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Ask a question about your documents to get started.",
      ),
    ).toBeTruthy();
  });

  it("disables Send when the input is empty or whitespace", () => {
    renderWithClient(<QAPage />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "   " } },
    );
    expect(send).toBeDisabled();

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "hello" } },
    );
    expect(send).toBeEnabled();
  });

  it("does not call ask for an empty or whitespace-only input", async () => {
    renderWithClient(<QAPage />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});
    expect(mockedAsk).not.toHaveBeenCalled();
  });

  it("clears the input after submitting", async () => {
    ask("Hello", "Hi there!", null);
    await askQuestion("Hello");
    expect(
      (screen.getByPlaceholderText(
        "Ask a question about your documents...",
      ) as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows a loading indicator while waiting for the answer", async () => {
    let resolveAsk: (value: QAResponse) => void;
    mockedAsk.mockReturnValue(
      new Promise<QAResponse>((resolve) => {
        resolveAsk = resolve;
      }),
    );

    renderWithClient(<QAPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Loading?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy();
    // Fields are disabled while the request is in flight.
    expect(
      screen.getByPlaceholderText("Ask a question about your documents..."),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await act(async () => {
      resolveAsk!({
        question: "Loading?",
        answer: "Done.",
        sources: [],
        model: null,
      });
    });
  });

  it("surfaces an error message when the request fails", async () => {
    mockedAsk.mockRejectedValue(new Error("AI service unavailable"));
    await askQuestion("Will this fail?");
    expect(screen.getByText("AI service unavailable")).toBeTruthy();
  });

  it("clears a previous error before the next request", async () => {
    mockedAsk
      .mockRejectedValueOnce(new Error("AI service unavailable"))
      .mockResolvedValueOnce({
        question: "Retry",
        answer: "Recovered.",
        sources: [],
        model: null,
      });

    await askQuestion("First");
    expect(screen.getByText("AI service unavailable")).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Retry" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    expect(screen.queryByText("AI service unavailable")).toBeNull();
    expect(await screen.findByText("Recovered.")).toBeTruthy();
  });

  it("renders the cited sources with their document filenames", async () => {
    const sources = [
      {
        chunk_id: "chunk-1",
        document_id: "doc-1",
        document_filename: "annual-report.pdf",
        content: "Revenue grew by 20% in Q4 across all segments.",
        score: 0.93,
        metadata_: null,
      },
    ];
    ask("What is the revenue growth?", "20% in Q4.", "gpt-4o-mini", sources);

    renderWithClient(<QAPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "What is the revenue growth?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Sources — why this document/)).toBeTruthy();
    expect(screen.getByText("annual-report.pdf")).toBeTruthy();
    // 0.93 distance → 7% similarity → the weak tone chip.
    expect(screen.getByText("7% match")).toBeTruthy();
    expect(
      screen.getByText(/closest semantic match to your question/),
    ).toBeTruthy();
    expect(
      screen.getByText(byFullText("Revenue grew by 20% in Q4 across all segments.")),
    ).toBeTruthy();
  });

  it("omits the sources section when the answer has no sources", async () => {
    ask("Hi", "No sources here", null);
    await askQuestion("Hi");
    expect(screen.queryByText(/Sources — why this document/)).not.toBeInTheDocument();
  });

  it("passes the persisted model from localStorage to the API", async () => {
    localStorage.setItem("askdocs-model", "gpt-4-turbo");
    mockedAsk.mockResolvedValue({
      question: "Model?",
      answer: "gpt-4-turbo",
      sources: [],
      model: "gpt-4-turbo",
    });

    await askQuestion("Model?");
    expect(mockedAsk).toHaveBeenCalledWith(
      "Model?",
      undefined,
      "gpt-4-turbo",
    );
  });

  it("sends undefined model when nothing is saved in localStorage", async () => {
    ask("Default model?", "The default.", null);
    await askQuestion("Default model?");
    expect(mockedAsk).toHaveBeenCalledWith("Default model?", undefined, undefined);
  });

  it("highlights the question terms inside the source preview", async () => {
    const sources: QAResponse["sources"] = [
      {
        chunk_id: "chunk-2",
        document_id: "doc-2",
        document_filename: "notes.txt",
        content: "Q3 planning meeting notes about revenue and growth.",
        score: 0.08,
        metadata_: null,
      },
    ];
    ask("What about Q3?", "Revenue grew.", null, sources);
    await askQuestion("What about Q3?");

    // The preview is clipped to 240 chars and query terms are <mark>ed
    // (tokens shorter than 3 chars like "Q3" are skipped by the matcher).
    expect(
      screen.getByText(byFullText("Q3 planning meeting notes about revenue and growth.")),
    ).toBeTruthy();
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]!.textContent).toBe("about");
  });

  it("navigates to a search scoped to the source document on click", async () => {
    const sources: QAResponse["sources"] = [
      {
        chunk_id: "chunk-3",
        document_id: "doc-9",
        document_filename: "security.txt",
        content: "Security policies live in the handbook.",
        score: 0.2,
        metadata_: null,
      },
    ];
    ask("Where is security covered?", "In the handbook.", null, sources);
    await askQuestion("Where is security covered?");

    fireEvent.click(screen.getByRole("button", { name: /security\.txt/ }));
    expect(navigateMock).toHaveBeenCalledWith(
      "/app/search?q=Where%20is%20security%20covered%3F&doc=doc-9",
    );
  });

  it("limits the question to the selected documents from the filter", async () => {
    mockedList.mockResolvedValue([
      {
        id: "doc-1",
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
    ]);
    ask("Only this doc?", "Yes.", null);

    renderWithClient(<QAPage />);
    await act(async () => {});

    fireEvent.click(await screen.findByRole("button", { name: /report.pdf/ }));
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Only this doc?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    expect(mockedAsk).toHaveBeenCalledWith("Only this doc?", ["doc-1"], undefined);
  });

  it("accumulates multiple turns as a conversation", async () => {
    ask("First?", "First answer.", null);
    await askQuestion("First?");

    ask("Second?", "Second answer.", null);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Second?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    expect(screen.getByText("First answer.")).toBeTruthy();
    expect(screen.getByText("Second answer.")).toBeTruthy();
    // Empty state disappears once the conversation starts.
    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
  });

  it("renders assistant answers as markdown", async () => {
    ask("Format?", "**bold** and `code`", null);

    renderWithClient(<QAPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Format?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("bold")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("distinguishes user messages from assistant messages", async () => {
    ask("Who are you?", "An assistant.", null);

    renderWithClient(<QAPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Who are you?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Who are you?")).toBeTruthy();
    // Both avatars render: U for the user, AI for the assistant.
    expect(screen.getAllByText("U").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AI").length).toBeGreaterThan(0);
  });

  it("renders the model picker with free and paid models", async () => {
    // Mirrors the backend registry's tiering: gpt-4o-mini is paid, so it must
    // not appear in the free group.
    mockedGetModels.mockResolvedValue({
      free: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
      paid: ["gpt-4o-mini", "gpt-4o"],
    });

    renderWithClient(<QAPage />);
    await act(async () => {});

    const select = screen.getByLabelText("Model");
    expect(
      screen.getByRole("option", { name: "openai/gpt-oss-120b" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "llama-3.3-70b-versatile" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "gpt-4o-mini" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "gpt-4o" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Provider default" })).toBeTruthy();
    expect((select as HTMLSelectElement).value).toBe("");
  });

  it("persists a selected model and passes it to ask", async () => {
    mockedGetModels.mockResolvedValue({ free: ["gpt-4o-mini"], paid: [] });
    ask("Model picker?", "Picked gpt-4o-mini.", "gpt-4o-mini");

    renderWithClient(<QAPage />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o-mini" },
    });
    expect(localStorage.getItem("askdocs-model")).toBe("gpt-4o-mini");

    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Model picker?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    expect(mockedAsk).toHaveBeenCalledWith(
      "Model picker?",
      undefined,
      "gpt-4o-mini",
    );
  });

  it("submits a suggested question from the empty state", async () => {
    ask("Which documents mention security?", "Security is covered.", null);

    renderWithClient(<QAPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Which documents mention security?" }),
    );
    await act(async () => {});

    expect(mockedAsk).toHaveBeenCalledWith(
      "Which documents mention security?",
      undefined,
      undefined,
    );
    expect(screen.getByText("Security is covered.")).toBeTruthy();
  });

  it("offers follow-up chips after an answer and appends them", async () => {
    ask("First?", "First answer.", null);
    await askQuestion("First?");

    ask("Can you elaborate on that?", "Elaboration.", null);
    fireEvent.click(
      screen.getByRole("button", { name: "Can you elaborate on that?" }),
    );
    await act(async () => {});

    expect(mockedAsk).toHaveBeenLastCalledWith(
      "Can you elaborate on that?",
      undefined,
      undefined,
    );
    // Both turns remain on screen.
    expect(screen.getByText("First answer.")).toBeTruthy();
    expect(screen.getByText("Elaboration.")).toBeTruthy();
    expect(
      screen.getByText("What are the key takeaways?"),
    ).toBeTruthy();
  });

  it("copies an answer to the clipboard with feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    ask("Copy?", "Copyable answer text.", null);

    renderWithClient(<QAPage />);
    fireEvent.change(
      screen.getByPlaceholderText("Ask a question about your documents..."),
      { target: { value: "Copy?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledWith("Copyable answer text.");
    expect(screen.getByText("Copied!")).toBeTruthy();
  });

  it("starts a new conversation with the New chat button", async () => {
    ask("Greeting?", "Hello!", null);
    await askQuestion("Greeting?");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await act(async () => {});

    expect(screen.getByText("No messages yet")).toBeTruthy();
    expect(screen.queryByText("Hello!")).not.toBeInTheDocument();
  });
});
describe("QAPage keyword-only retrieval", () => {
  beforeEach(() => {
    mockedList.mockResolvedValue([]);
    mockedGetModels.mockResolvedValue({ free: [], paid: [] });
  });

  it("warns that the answer was grounded in literal matches", async () => {
    // An answer that quietly missed the relevant passage is indistinguishable
    // from a model that was simply wrong, so the cause has to be on screen.
    ask("q", "A", "llama3.2:1b", [], "keyword");

    await askQuestion("q");

    const notice = document.querySelector(".search-mode-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Keyword-only retrieval");
    expect(notice?.getAttribute("role")).toBe("status");
  });

  it("says which key costs money and which do not", async () => {
    // The notice used to name only OPENAI_API_KEY, which is the paid one, and
    // said nothing about the two free paths — so a reader could reasonably
    // assume the key it named was the free option.
    ask("q", "A", "llama3.2:1b", [], "keyword");

    await askQuestion("q");

    const text = document.querySelector(".search-mode-notice")?.textContent ?? "";
    expect(text).toContain("bills your OpenAI account");
    expect(text).toContain("GROQ_API_KEY");
    expect(text).toContain("LOCAL_LLM_ENABLED=true");
    // Groq and a local server serve chat models, not embeddings. Promising
    // otherwise would send the reader to set a key that cannot fix the notice.
    expect(text).toContain("cannot supply embeddings");
  });

  it("says nothing when retrieval was semantic", async () => {
    ask("q", "A", "gpt-4o-mini", [], "semantic");

    await askQuestion("q");

    expect(document.querySelector(".search-mode-notice")).toBeNull();
  });

  it("says nothing when an older backend omits the mode", async () => {
    mockedAsk.mockResolvedValue({
      question: "q",
      answer: "A",
      sources: [],
      model: "gpt-4o-mini",
    });

    await askQuestion("q");

    expect(document.querySelector(".search-mode-notice")).toBeNull();
  });
});
