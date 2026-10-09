import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "../components/LandingNavbar";
import { LandingFooter } from "../components/LandingFooter";
import { Markdown } from "../components/Markdown";
import { Badge } from "../components/Badge";
import { HighlightedText } from "../components/HighlightedText";
import { MatchChip } from "../components/MatchChip";
import { Tabs } from "../components/Tabs";
import type { TabDef } from "../components/Tabs";
import { Walkthrough } from "../components/Walkthrough";
import { DEMO_DOCUMENTS } from "./demoData";
import type { DemoSampleDoc } from "./demoData";

/** session-only usage limits for the demo */
const LIMITS = {
  searches: 10,
  qa: 5,
} as const;

const KEY_SEARCH = "askdocs-demo-searches";
const KEY_QA = "askdocs-demo-qa";

/**
 * Whether the walkthrough has already been shown.
 *
 * localStorage, not sessionStorage, deliberately. The counters above are
 * *session*-only on purpose, but "first visit only" for a tour means once
 * across visits — a sessionStorage flag would re-nag on every new tab, which is
 * the behaviour the issue is trying to get rid of. The demo's isolation
 * guarantee is untouched: this key is written by the walkthrough and read by
 * nothing else.
 */
const KEY_TOUR = "askdocs-demo-tour-seen";

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
  /* Search and Ask are one tablist. All of their state lives here rather than
     inside the panels: `Tabs` renders only the active panel, so anything kept
     in a panel's own subtree would be unmounted on a tab switch and lost. */
  const [activeTab, setActiveTab] = useState("search");
  const [tourOpen, setTourOpen] = useState(() => window.localStorage.getItem(KEY_TOUR) === null);
  const tourTriggerRef = useRef<HTMLButtonElement>(null);

  const searchesLeft = Math.max(0, LIMITS.searches - searchCount);
  const qaLeft = Math.max(0, LIMITS.qa - qaCount);
  const searchCapped = searchCount >= LIMITS.searches;
  const qaCapped = qaCount >= LIMITS.qa;

  /**
   * Reads as a budget rather than a countdown: "3 of 5 questions used" states
   * the spend *and* the ceiling, where "5 questions left" only states what
   * remains — so a user who never reaches the end still never learns there is
   * a ceiling. The remaining count is kept as the non-visual suffix, because
   * "used" alone loses the same information for a screen reader.
   *
   * This is the *only* place the long form appears. The tab strip carries a
   * short "N left" per tab (so a budget is visible for the tab you are not on)
   * and the panel counter says nothing at all until the budget runs out. Three
   * renderings of one number in one screen is noise, and the first draft of
   * this page had exactly that — the header badge and the panel counter printed
   * the identical sentence.
   */
  function budget(used: number, limit: number, noun: string): string {
    const left = Math.max(0, limit - used);
    return `${used} of ${limit} ${noun} used — ${left} left`;
  }

  function closeTour() {
    window.localStorage.setItem(KEY_TOUR, "1");
    setTourOpen(false);
    /* Returning focus to the control that opened it is what makes dismissal
       feel like dismissal rather than a teleport. Safe unconditionally: if the
       walkthrough opened itself on load, the ref is empty and this is a no-op
       rather than a null deref. */
    tourTriggerRef.current?.focus();
  }

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
      const best = hits[0]!;
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

      <div className="demo-banner forced-dark">
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
            Explore the platform with sample documents. Searches and questions are limited per
            session — sign up for unlimited access.
          </p>
          <div className="demo-usage">
            <Badge tone="blue">{DEMO_DOCUMENTS.length} sample docs</Badge>
            <Badge tone="blue">{budget(searchCount, LIMITS.searches, "searches")}</Badge>
            <Badge tone="blue">{budget(qaCount, LIMITS.qa, "questions")}</Badge>
            <button
              type="button"
              className="btn btn-secondary demo-tour-button"
              ref={tourTriggerRef}
              onClick={() => setTourOpen(true)}
            >
              Take the tour
            </button>
          </div>
        </header>

        {tourOpen && (
          <Walkthrough
            onClose={closeTour}
            steps={[
              {
                title: "Three sample documents, already indexed",
                body: (
                  <>
                    <p>
                      Each card says what is inside the document and what it is good for, so you can
                      pick one instead of guessing from a filename. They are pre-processed — 5
                      chunks each, status <strong>ready</strong> — which is what the real pipeline
                      does in the background after an upload.
                    </p>
                    <p>Try searching for “benefits”, or ask about day one.</p>
                  </>
                ),
              },
              {
                title: "Search and Ask are two tabs",
                body: (
                  <p>
                    <strong>Search</strong> returns ranked passages with the matching terms
                    highlighted. <strong>Ask</strong> answers in prose and cites the document it
                    drew on. They were stacked vertically, so each pushed the other off screen; now
                    only one is visible and each keeps its own results when you switch.
                  </p>
                ),
              },
              {
                title: "Ten searches and five questions per session",
                body: (
                  <p>
                    The badges above are a budget, not a countdown: they show what you have spent
                    and the ceiling. Both counters live in this tab only, so they reset when you
                    close it — nothing here touches your account, and no document is uploaded.
                  </p>
                ),
              },
            ]}
          />
        )}

        {/* White page, dark objects: each box keeps its own dark treatment —
            the sample cards, the search bar and the result/chat boxes — rather
            than one panel swallowing the sections. Text between the boxes (the
            page header, section titles, empty states) stays on the light theme
            (#715). */}
        <section aria-label="Sample documents">
          <h2 className="demo-section-title">Sample documents</h2>
          <div className="document-grid forced-dark">
            {DEMO_DOCUMENTS.map((doc) => (
              <div key={doc.id} className="document-card">
                <div className="document-card-header">
                  <div className="file-icon" aria-hidden="true">
                    FILE
                  </div>
                  <div className="document-info">
                    <h3>{doc.filename}</h3>
                    <p>{doc.mime_type}</p>
                  </div>
                </div>
                <p className="demo-doc-description">{doc.description}</p>
                <div className="document-card-body">
                  <div className="status-row">
                    <span>Status:</span>
                    <Badge tone="green">{doc.status}</Badge>
                  </div>
                  <p className="date">{doc.chunks.length} indexed chunks</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Search and ask" className="demo-section">
          <Tabs
            label="Search and ask"
            activeId={activeTab}
            onChange={setActiveTab}
            tabs={
              [
                { id: "search", label: "Search", hint: `${searchesLeft} left` },
                { id: "ask", label: "Ask", hint: `${qaLeft} left` },
              ] satisfies TabDef[]
            }
          >
            {(active) =>
              active === "search" ? (
                <div className="demo-panel">
                  <form onSubmit={handleSearch} className="search-form">
                    <div className="search-input-group forced-dark">
                      <input
                        id="demo-search"
                        name="demo-search"
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search sample documents..."
                        aria-label="Search sample documents"
                        autoComplete="off"
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
                      {searchCapped && "Search limit reached for this session."}
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
                        <div key={result.chunkId} className="search-result-card forced-dark">
                          <div className="result-header">
                            <span className="result-document">{result.doc.filename}</span>
                            <MatchChip pct={result.score * 100} />
                          </div>
                          <p className="result-content">
                            <HighlightedText text={result.chunk} query={searchQuery} />
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="chat-container">
                  <div className="chat-messages">
                    {messages.length === 0 && !qaCapped && (
                      <div className="empty-state">
                        <p>Ask about the sample documents to see a demo answer.</p>
                      </div>
                    )}

                    {qaCapped && renderSignUpCta("qa")}

                    {messages.map((message) => (
                      <div key={message.id} className={`chat-message forced-dark ${message.role}`}>
                        <div className="message-avatar">{message.role === "user" ? "U" : "AI"}</div>
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

                  <form onSubmit={handleAsk} className="chat-input-form forced-dark">
                    <input
                      id="demo-question"
                      name="demo-question"
                      type="text"
                      value={qaInput}
                      onChange={(e) => setQaInput(e.target.value)}
                      placeholder="Ask about the sample documents..."
                      aria-label="Ask a question about the sample documents"
                      autoComplete="off"
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
                    {qaCapped && "Q&A limit reached for this session."}
                  </p>
                </div>
              )
            }
          </Tabs>
        </section>
      </main>

      {/* The demo was the one public page without the footer, so it offered no
          way to reach Pricing, Contact, or anything legal. */}
      <LandingFooter />
    </div>
  );
}

export default DemoPage;
