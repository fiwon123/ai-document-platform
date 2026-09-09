import { useState } from "react";
import { DocumentFilter } from "../components/DocumentFilter";
import { qa } from "../services/api";
import type { QAResponse, SearchResult } from "../types";
import { Spinner } from "../components/Spinner";
import { Markdown } from "../components/Markdown";
import { EmptyState } from "../components/EmptyState";

interface Message {
  id: string;
  type: "user" | "assistant";
  content: string;
  sources?: SearchResult[];
  model?: string | null;
}

export function QAPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: "user",
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const response: QAResponse = await qa.ask(
        input,
        selectedIds.length > 0 ? selectedIds : undefined,
        localStorage.getItem("askdocs-model") ?? undefined,
      );

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: "assistant",
        content: response.answer,
        sources: response.sources,
        model: response.model,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get answer");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="page qa-page">
      <header className="page-header">
        <h1>Document Q&A</h1>
        <p>Ask questions about your documents and get AI-powered answers</p>
      </header>

      <DocumentFilter selected={selectedIds} onChange={setSelectedIds} />

      <div className="chat-container">
        <div className="chat-messages">
          {messages.length === 0 && (
            <EmptyState
              title="No messages yet"
              description="Ask a question about your documents to get started."
            />
          )}

          {messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.type}`}>
              <div className="message-avatar">
                {message.type === "user" ? "U" : "AI"}
              </div>
              <div className="message-content">
                {message.type === "assistant" ? (
                  <>
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
                    <strong>Sources:</strong>
                    {message.sources.map((source) => (
                      <div key={source.chunk_id} className="source-item">
                        <span className="source-document">
                          {source.document_filename}
                        </span>
                        <span className="source-preview">
                          {source.content.substring(0, 100)}...
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

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