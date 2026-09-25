import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { DocumentFilter } from "../components/DocumentFilter";
import { qa } from "../services/api";
import type { QAResponse, SearchResult } from "../types";
import { Spinner } from "../components/Spinner";
import { Markdown } from "../components/Markdown";
import { EmptyState } from "../components/EmptyState";
import { HighlightedText } from "../components/HighlightedText";
import { MatchChip } from "../components/MatchChip";

const MODEL_KEY = "askdocs-model";

const SUGGESTED_QUESTIONS = [
  "What can I learn about my uploaded documents?",
  "Which documents mention security?",
  "Summarize the key points in my documents",
  "What are the product highlights?",
];

const FOLLOW_UPS = [
  "Can you elaborate on that?",
  "What are the key takeaways?",
];

interface Message {
  id: string;
  type: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  model?: string | null;
}

/** Copy fallback for insecure contexts where navigator.clipboard is missing. */
  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // No-op fallback: keep the button safe (never throws) in non-secure
    // contexts (e.g. plain-http previews that lack the Clipboard API).
  }

export function QAPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [model, setModel] = useState(
    () => localStorage.getItem(MODEL_KEY) ?? "",
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  /** The user question that produced the message at `index` (walk back). */
  function questionFor(index: number): string {
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i]!.type === "user") return messages[i]!.content;
    }
    return "";
  }

  const modelsQuery = useQuery({
    queryKey: ["qa-models"],
    queryFn: qa.getModels,
    // Keep the picker usable while models load: an empty list renders just
    // the "Provider default" option.
    placeholderData: { free: [], paid: [] },
  });
  const freeModels = modelsQuery.data?.free ?? [];
  const paidModels = modelsQuery.data?.paid ?? [];

  const askMutation = useMutation({
    mutationFn: (question: string) =>
      qa.ask(
        question,
        selectedIds.length > 0 ? selectedIds : undefined,
        localStorage.getItem(MODEL_KEY) ?? undefined,
      ),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to get answer");
    },
  });
  const isLoading = askMutation.isPending;

  // Auto-scroll to the newest message as turns are added (guarded: jsdom and
  // older browsers may not implement Element#scrollIntoView).
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [messages, isLoading]);

  async function sendQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: "user",
      content: trimmed,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setError(null);
    setCopiedId(null);

    try {
      const response: QAResponse = await askMutation.mutateAsync(trimmed);
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: "assistant",
        content: response.answer,
        sources: response.sources,
        model: response.model,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      // The mutation's onError already surfaced the message.
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendQuestion(input);
  }

  function handleModelChange(next: string) {
    setModel(next);
    if (next) {
      localStorage.setItem(MODEL_KEY, next);
    } else {
      localStorage.removeItem(MODEL_KEY);
    }
  }

  function resetConversation() {
    setMessages([]);
    setError(null);
    setCopiedId(null);
  }

  const lastMessage = messages[messages.length - 1];
  const showFollowUps =
    messages.length > 0 &&
    lastMessage?.type === "assistant" &&
    !isLoading;

  return (
    <div className="page qa-page">
      <header className="page-header">
        <h1>Document Q&A</h1>
        <p>Ask questions about your documents and get AI-powered answers</p>
      </header>

      <DocumentFilter selected={selectedIds} onChange={setSelectedIds} />

      <div className="qa-controls">
        <label className="qa-model-label" htmlFor="qa-model">
          Model
        </label>
        <select
          id="qa-model"
          className="qa-model-select"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
        >
          <option value="">Provider default</option>
          {freeModels.length > 0 && (
            <optgroup label="Free models">
              {freeModels.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
          {paidModels.length > 0 && (
            <optgroup label="Bring your own key">
              {paidModels.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {messages.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm qa-new-chat"
            onClick={resetConversation}
          >
            New chat
          </button>
        )}
      </div>

      <div className="chat-container">
        {/* Live region: screen readers announce new messages as they are
            added (role="log" implies aria-live="polite"). */}
        <div
          className="chat-messages"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {messages.length === 0 && (
            <EmptyState
              title="No messages yet"
              description="Ask a question about your documents to get started."
            >
              <div className="qa-suggested-questions">
                {SUGGESTED_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => void sendQuestion(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </EmptyState>
          )}

          {messages.map((message, index) => (
            <div key={message.id} className={`chat-message ${message.type}`}>
              <div className="message-avatar">
                {message.type === "user" ? "U" : "AI"}
              </div>
              <div className="message-content">
                {message.type === "assistant" ? (
                  <>
                    <button
                      type="button"
                      className="copy-answer-btn"
                      aria-label="Copy answer"
                      onClick={() => {
                        void copyText(message.content).then(() =>
                          setCopiedId(message.id),
                        );
                      }}
                      title="Copy the answer to the clipboard"
                    >
                      {copiedId === message.id ? "Copied!" : "Copy"}
                    </button>
                    <Markdown>{message.content}</Markdown>
                    {message.model && (
                      <span className="model-badge">
                        Answered by {message.model}
                      </span>
                    )}
                  </>
                ) : (
                  <p>{message.content}</p>
                )}
                {message.sources && message.sources.length > 0 && (
                  <div className="message-sources">
                    <strong>Sources — why this document:</strong>
                    {message.sources.map((source) => {
                      const question = questionFor(index);
                      return (
                        <button
                          key={source.chunk_id}
                          type="button"
                          className="source-item"
                          title="Open this passage in semantic search"
                          onClick={() =>
                            navigate(
                              `/app/search?q=${encodeURIComponent(question)}&doc=${encodeURIComponent(source.document_id)}`,
                            )
                          }
                        >
                          <span className="source-document">
                            {source.document_filename}
                            <MatchChip pct={(1 - source.score) * 100} />
                          </span>
                          <span className="source-reason">
                            Why this source: this passage is the closest
                            semantic match to your question.
                          </span>
                          <span className="source-preview">
                            <HighlightedText
                              text={source.content.substring(0, 240)}
                              query={question}
                            />
                            {source.content.length > 240 && "…"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}

          {showFollowUps && (
            <div className="chat-followups" aria-label="Suggested follow-ups">
              {FOLLOW_UPS.map((followUp) => (
                <button
                  key={followUp}
                  type="button"
                  className="suggestion-chip"
                  onClick={() => void sendQuestion(followUp)}
                >
                  {followUp}
                </button>
              ))}
            </div>
          )}

          {isLoading && (
            <div className="chat-message assistant">
              <div className="message-avatar">AI</div>
              <div className="message-content">
                <span className="typing">
                  <Spinner size={16} label="Thinking" />
                  Thinking…
                </span>
              </div>
            </div>
          )}

          <div ref={endRef} />
        </div>

        {error && <p className="error-message" role="alert">{error}</p>}

        <form onSubmit={handleSubmit} className="chat-input-form">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your documents..."
            aria-label="Ask a question about your documents"
            className="chat-input"
            disabled={isLoading}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isLoading || !input.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}