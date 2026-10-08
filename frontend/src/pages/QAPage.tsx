import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { DocumentFilter } from "../components/DocumentFilter";
import { describeRateLimit, qa, rateLimitFrom } from "../services/api";
import type { RateLimitInfo } from "../services/api";
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

const FOLLOW_UPS = ["Can you elaborate on that?", "What are the key takeaways?"];

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

/**
 * Mirrors `question: str = Field(..., max_length=2000)` in
 * `backend/src/app/schemas/qa.py`. Nothing exposes the server's limits at
 * runtime, so the two are kept in step by hand and by this comment; the browser
 * cap turns an over-long paste into visible feedback rather than a 422 the user
 * cannot act on.
 */
const MAX_QUESTION_LENGTH = 2000;

/** Show the count once the cap is close enough to be worth the pixels. */
const QUESTION_COUNTER_FROM = MAX_QUESTION_LENGTH - 200;

export function QAPage() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Rate limits are kept apart from `error` so the notice can be its own
  // thing: temporary, with a wait, and not phrased like a crash.
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Answer quality is bounded by retrieval quality, so a keyword-only backend
  // degrades this page too -- and an answer that quietly missed the relevant
  // passage looks exactly like a model that was simply wrong.
  const [isKeywordOnly, setIsKeywordOnly] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? "");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Monotonic message ids from a ref rather than Date.now(): a wall-clock id
  // is not guaranteed unique (two turns created in the same millisecond
  // collide, which breaks the React key and the copied-message tracking), and
  // reading the clock from component code is what the purity rule flags.
  const nextMessageId = useRef(0);
  const allocateMessageId = () => `msg-${nextMessageId.current++}`;

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
    onError: (err, question) => {
      // A rate limit is a temporary condition with a known wait, not a
      // failure: it gets its own state so the notice can say when it lifts
      // instead of quoting an internal provider id at the user. Every other
      // error keeps the message it always had.
      const limit = rateLimitFrom(err);
      if (limit) {
        setRateLimit(limit);
        setError(null);
        // The question is already in the transcript as a user turn, so nothing
        // is lost — but putting it back in the box makes retrying one action
        // (press send) instead of retyping a long question.
        setInput((current) => current || question || "");
        return;
      }
      setRateLimit(null);
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
      id: allocateMessageId(),
      type: "user",
      content: trimmed,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setError(null);
    setRateLimit(null);
    setCopiedId(null);

    try {
      const response: QAResponse = await askMutation.mutateAsync(trimmed);
      if (response.mode === "keyword") setIsKeywordOnly(true);
      const assistantMessage: Message = {
        id: allocateMessageId(),
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
  const showFollowUps = messages.length > 0 && lastMessage?.type === "assistant" && !isLoading;

  return (
    <div className="page qa-page">
      <header className="page-header">
        <h1>Document Q&A</h1>
        <p>Ask questions about your documents and get AI-powered answers</p>
      </header>

      <DocumentFilter selected={selectedIds} onChange={setSelectedIds} />

      <div className="qa-controls forced-dark">
        <label className="qa-model-label" htmlFor="qa-model">
          Model
        </label>
        <select
          id="qa-model"
          name="qa-model"
          autoComplete="off"
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

      <div className="chat-container forced-dark">
        {/* Live region: screen readers announce new messages as they are
            added (role="log" implies aria-live="polite"). */}
        <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
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
            <div key={message.id} className={`chat-message forced-dark ${message.type}`}>
              <div className="message-avatar">{message.type === "user" ? "U" : "AI"}</div>
              <div className="message-content">
                {message.type === "assistant" ? (
                  <>
                    <button
                      type="button"
                      className="copy-answer-btn"
                      aria-label="Copy answer"
                      onClick={() => {
                        void copyText(message.content).then(() => setCopiedId(message.id));
                      }}
                      title="Copy the answer to the clipboard"
                    >
                      {copiedId === message.id ? "Copied!" : "Copy"}
                    </button>
                    <Markdown>{message.content}</Markdown>
                    {message.model && (
                      <span className="model-badge">Answered by {message.model}</span>
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
                            Why this source: this passage is the closest semantic match to your
                            question.
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

        {rateLimit && (
          <p className="rate-limit-notice" role="status">
            {describeRateLimit(rateLimit)}
          </p>
        )}

        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}

        {isKeywordOnly && (
          <p className="search-mode-notice" role="status">
            <strong>Keyword-only retrieval.</strong> No embedding provider is configured, so the
            passages given to the model were found by literal matching. Relevant context can be
            missing from the answer. Semantic retrieval needs either <code>OPENAI_API_KEY</code>,
            which bills your OpenAI account per token, or <code>LOCAL_LLM_ENABLED=true</code> with a
            local model server, which is free. A free <code>GROQ_API_KEY</code> serves chat models
            only — it cannot supply embeddings.
          </p>
        )}

        <form onSubmit={handleSubmit} className="chat-input-form">
          <input
            id="qa-question"
            name="qa-question"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your documents..."
            aria-label="Ask a question about your documents"
            autoComplete="off"
            className="chat-input"
            disabled={isLoading}
            maxLength={MAX_QUESTION_LENGTH}
          />
          {input.length >= QUESTION_COUNTER_FROM && (
            <span
              className="chat-input-counter"
              // Polite: the count changes on every keystroke, so announcing it
              // would talk over the question being typed.
              aria-live="polite"
            >
              {input.length} / {MAX_QUESTION_LENGTH}
            </span>
          )}
          <button type="submit" className="btn btn-primary" disabled={isLoading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
