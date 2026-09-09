import { useState } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "../components/LandingNavbar";
import { Markdown } from "../components/Markdown";

/** session-only usage limits for the demo */
const LIMITS = {
  searches: 10,
  qa: 5,
} as const;

const KEY_SEARCH = "askdocs-demo-searches";
const KEY_QA = "askdocs-demo-qa";

/**
 * All demo counters live in sessionStorage (key prefix `askdocs-demo-*`).
 * It survives reloads but is cleared when the tab closes — exactly the
 * "session-only" semantics we want. localStorage is never used.
 */
const store = window.sessionStorage;

function readCount(key: string): number {
  const raw = store.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function incrementCount(key: string): number {
  const next = readCount(key) + 1;
  store.setItem(key, String(next));
  return next;
}

export interface DemoSampleDoc {
  id: string;
  filename: string;
  mime_type: string;
  status: "ready";
  chunks: string[];
}

/** Pre-seeded sample documents, mocked locally — no API calls in demo mode. */
export const DEMO_DOCUMENTS: DemoSampleDoc[] = [
  {
    id: "demo-company-handbook",
    filename: "company-handbook.pdf",
    mime_type: "application/pdf",
    status: "ready",
    chunks: [
      "Welcome to Acme Corp. Our mission is to build reliable, human-friendly software that helps teams stay organized and ship with confidence.",
      "All employees receive unlimited paid time off, a home office stipend, and health coverage starting on day one. Review the full benefits catalog in Workday.",
      "Remote-first means meetings are async by default. Team standups happen over Slack, and the weekly demo is recorded for anyone in a different time zone.",
      "Expense reimbursement is submitted through the Finance portal and approved within five business days. Receipts must show vendor, amount, and currency.",
      "Security matters: enable two-factor authentication, never share credentials, and report phishing attempts to security@acmecorp.com immediately.",
    ],
  },
  {
    id: "demo-onboarding-guide",
    filename: "onboarding-guide.pdf",
    mime_type: "application/pdf",
    status: "ready",
    chunks: [
      "Day one: your manager will schedule a 1:1, IT will send a laptop, and you will get read access to the engineering wiki and the product roadmap.",
      "The first week focuses on environment setup: clone the monorepo, install the dev tools, and run the local stack against the staging API.",
      "By the end of your first sprint you should open your first pull request. Follow the checklist in the contribution guide so CI stays green.",
      "You are assigned a buddy for your first 30 days — they can unblock you, review your early PRs, and introduce you to the people you will work with.",
      "When you are stuck, search the internal knowledge base first, then ask in #help. Nobody expects you to know everything on day one.",
    ],
  },
  {
    id: "demo-design-system",
    filename: "design-system.md",
    mime_type: "text/markdown",
    status: "ready",
    chunks: [
      "The design system is built on tokens. Color tokens include ink, paper, surface, muted, line, blue, and green, with dark-theme variants.",
      "Spacing uses a 4px base scale: 4, 8, 12, 16, 24, 32, 48, and 64. Use tokens instead of magic numbers so dark mode stays consistent.",
      "Buttons come in three variants: primary for the main action, secondary for alternatives, and danger for destructive edits. Always disable loading buttons.",
      "Forms use accessible labels with the .form-group wrapper, and inputs show a blue focus ring. Error messages use the danger tokens and role=\"alert\".",
      "Everything ships with reduced-motion support and prefers-color-scheme. Run the axe scan in CI before merging any UI change.",
    ],
  },
];

interface DemoMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  source?: { filename: string; preview: string };
}

interface ChunkHit {
  doc: DemoSampleDoc;
  chunk: string;
  score: number;
}

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `demo-msg-${messageSeq}`;
}

/**
 * Client-side mock search/QA. The full query is matched as a case-insensitive
 * substring first; when that misses (typical for natural-language questions),
 * individual keywords are matched and scored instead.
 */
function matchChunks(query: string): ChunkHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const keywords = Array.from(new Set(q.split(/\s+/).filter((w) => w.length >= 3)));
  const hits: ChunkHit[] = [];

  for (const doc of DEMO_DOCUMENTS) {
    for (const chunk of doc.chunks) {
      const lower = chunk.toLowerCase();
      const exact = lower.includes(q);
      const matched = keywords.filter((w) => lower.includes(w));

      if (!exact && matched.length === 0) continue;

      // Fake a plausible relevance score: exact substring match scores higher
      // than a partial keyword overlap, with a small bonus for lead position.
      let score = exact ? 0.95 : 0.4 + (matched.length / keywords.length) * 0.5;
      const firstIdx = exact
        ? lower.indexOf(q)
        : Math.min(...matched.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
      if (firstIdx === 0) score = Math.min(0.99, score + 0.08);

      hits.push({ doc, chunk, score });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}

export function DemoPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { chunkId: string; doc: DemoSampleDoc; chunk: string; score: number }[]
  >([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchCount, setSearchCount] = useState(() => readCount(KEY_SEARCH));
  const [qaCount, setQaCount] = useState(() => readCount(KEY_QA));
  const [messages, setMessages] = useState<DemoMessage[]>([]);
  const [qaInput, setQaInput] = useState("");

  const searchesLeft = Math.max(0, LIMITS.searches - searchCount);
  const qaLeft = Math.max(0, LIMITS.qa - qaCount);
  const searchCapped = searchCount >= LIMITS.searches;
  const qaCapped = qaCount >= LIMITS.qa;

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || searchCapped) return;

    incrementCount(KEY_SEARCH);
    setSearchCount(readCount(KEY_SEARCH));

    const hits = matchChunks(q);
    setSearchResults(
      hits.slice(0, 5).map((hit, i) => ({
        chunkId: `${hit.doc.id}:${i}`,
        doc: hit.doc,
        chunk: hit.chunk,
        score: hit.score,
      })),
    );
    setHasSearched(true);
  }

  function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = qaInput.trim();
    if (!q || qaCapped) return;

    incrementCount(KEY_QA);
    setQaCount(readCount(KEY_QA));

    const userMessage: DemoMessage = { id: nextMessageId(), role: "user", content: q };

    const hits = matchChunks(q);
    let assistant: DemoMessage;
    if (hits.length > 0) {
      const best = hits[0];
      assistant = {
        id: nextMessageId(),
        role: "assistant",
        content: `${best.chunk}\n\n*Answered by the demo assistant from "${best.doc.filename}".*`,
        source: { filename: best.doc.filename, preview: best.chunk },
      };
    } else {
      assistant = {
        id: nextMessageId(),
        role: "assistant",
        content:
          "I could not find a matching passage in the sample documents. Try asking about the company handbook, the onboarding guide, or the design system.\n\n*Answered by the demo assistant.*",
      };
    }

    setMessages((prev) => [...prev, userMessage, assistant]);
    setQaInput("");
  }

  function renderSignUpCta(kind: "search" | "qa") {
    const headline =
      kind === "search"
        ? "You have reached the demo search limit."
        : "You have reached the demo Q&A limit.";
    return (
      <div className="demo-limit-block" role="status">
        <p>{headline}</p>
        <p>Sign up to keep searching and asking questions about your documents.</p>
        <Link to="/register" className="btn btn-primary">
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="demo-page">
      <LandingNavbar />

      <div className="demo-banner">
        <p>
          <strong>Demo mode.</strong> Sign up to save your work and access more models.
        </p>
        <Link to="/register" className="btn btn-primary">
          Sign up
        </Link>
        <Link to="/" className="demo-back-home">
          Back to home
        </Link>
      </div>

      <main className="demo-content page">
        <header className="page-header">
          <h1>Try the demo</h1>
          <p>
            Explore the platform with sample documents. Searches and questions are
            limited per session — sign up for unlimited access.
          </p>
          <p className="demo-usage">
            <span className="status-badge">{DEMO_DOCUMENTS.length} sample docs</span>
            <span className="status-badge">{searchesLeft} searches left</span>
            <span className="status-badge">{qaLeft} questions left</span>
          </p>
        </header>

        <section aria-label="Sample documents">
          <h2 className="demo-section-title">Sample documents</h2>
          <div className="document-grid">
            {DEMO_DOCUMENTS.map((doc) => (
              <div key={doc.id} className="document-card">
                <div className="document-card-header">
                  <div className="file-icon" aria-hidden="true">FILE</div>
                  <div className="document-info">
                    <h3>{doc.filename}</h3>
                    <p>{doc.mime_type}</p>
                  </div>
                </div>
                <div className="document-card-body">
                  <div className="status-row">
                    <span>Status:</span>
                    <span className="status-badge" style={{ backgroundColor: "#10b981" }}>
                      {doc.status}
                    </span>
                  </div>
                  <p className="date">{doc.chunks.length} indexed chunks</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Search sample documents" className="demo-section">
          <h2 className="demo-section-title">Search the sample documents</h2>
          <form onSubmit={handleSearch} className="search-form">
            <div className="search-input-group">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sample documents..."
                aria-label="Search sample documents"
                className="search-input"
                disabled={searchCapped}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={searchCapped || !searchQuery.trim()}
              >
                Search
              </button>
            </div>
            <p className="demo-counter">
              {searchCapped
                ? "Search limit reached for this session."
                : `${searchesLeft} search${searchesLeft === 1 ? "" : "es"} remaining`}
            </p>
          </form>

          {searchCapped && renderSignUpCta("search")}

          {!searchCapped && hasSearched && searchResults.length === 0 && (
            <div className="empty-state">
              <p>No results found for "{searchQuery}"</p>
            </div>
          )}

          {!searchCapped && searchResults.length > 0 && (
            <div className="search-results">
              <h2>Results ({searchResults.length})</h2>
              {searchResults.map((result) => (
                <div key={result.chunkId} className="search-result-card">
                  <div className="result-header">
                    <span className="result-document">{result.doc.filename}</span>
                    <span className="result-score">
                      Score: {(result.score * 100).toFixed(1)}%
                    </span>
                  </div>
                  <p className="result-content">{result.chunk}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Ask questions" className="demo-section">
          <h2 className="demo-section-title">Ask questions</h2>
          <div className="chat-container">
            <div className="chat-messages">
              {messages.length === 0 && !qaCapped && (
                <div className="empty-state">
                  <p>Ask about the sample documents to see a demo answer.</p>
                </div>
              )}

              {qaCapped && renderSignUpCta("qa")}

              {messages.map((message) => (
                <div key={message.id} className={`chat-message ${message.role}`}>
                  <div className="message-avatar">
                    {message.role === "user" ? "U" : "AI"}
                  </div>
                  <div className="message-content">
                    {message.role === "assistant" ? (
                      <>
                        <span className="demo-model-badge">AskDocs demo</span>
                        <Markdown>{message.content}</Markdown>
                      </>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    {message.source && (
                      <div className="message-sources">
                        <strong>Source:</strong>
                        <div className="source-item">
                          <span className="source-document">{message.source.filename}</span>
                          <span className="source-preview">{message.source.preview}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleAsk} className="chat-input-form">
              <input
                type="text"
                value={qaInput}
                onChange={(e) => setQaInput(e.target.value)}
                placeholder="Ask a question about the sample documents..."
                aria-label="Ask a question about the sample documents"
                className="chat-input"
                disabled={qaCapped}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={qaCapped || !qaInput.trim()}
              >
                Send
              </button>
            </form>
            <p className="demo-counter">
              {qaCapped
                ? "Q&A limit reached for this session."
                : `${qaLeft} question${qaLeft === 1 ? "" : "s"} remaining`}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

export default DemoPage;