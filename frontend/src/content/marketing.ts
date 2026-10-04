/**
 * Marketing site content.
 *
 * Single source of truth for everything the marketing pages render. The
 * landing page and the dedicated `/features`, `/how-it-works` and `/pricing`
 * pages all read from here, so a plan limit or feature description can never
 * say one thing on the landing page and another on its own page.
 *
 * Content is plain typed data — no CMS, no markdown pipeline. Swapping this for
 * a CMS later means changing this module's exports, not the pages.
 */

export type Accent = "blue" | "violet" | "green" | "amber" | "rose";

export type Feature = { title: string; body: string; icon: string; accent: Accent };

/* ------------------------------------------------------------------ icons */

export const ICONS = {
  upload:
    "M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  search:
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  chat: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  shield:
    "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  bolt: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  bulk: "M4 7h16M4 12h16M4 17h10",
  export:
    "M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  webhook:
    "M18 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6-9a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-5 2 2.5 3.5M15 9.5l2.5 3.5",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5V11Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2.7 3.8-5.7 3.8-9S14.5 5.7 12 3m0 18c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3M3.5 9h17M3.5 15h17",
  key: "M15 7a4 4 0 1 0-3.9 5H8v3H5v3H2v-3l7.1-7.1A4 4 0 0 1 15 7Z",
};

export const STEP_ICONS = {
  upload:
    "M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  chat: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
};

/**
 * Social glyphs, as SVG path data.
 *
 * GitHub is on a 16x16 grid and everything else is on 24x24, so its glyph MUST
 * be given a matching `viewBox` (see `SocialLink` in LandingFooter) or it will
 * render at two-thirds size next to its neighbours.
 *
 * The GitHub glyph is the Octicons "mark-github" — a solid disc with the Octocat
 * knocked out — rather than the Octocat *silhouette* this used to ship. The two
 * have almost identical bounding boxes (both ~0.975 w:h), so the silhouette's
 * problem was never its aspect ratio; it was the silhouette itself. The Octocat
 * is an egg-shaped blob, and an egg-shaped blob inside a round button reads as an
 * oval next to a flat bird and a rounded square. A disc reads as a circle, which
 * is what the surrounding button already is.
 */
export const SOCIAL_PATHS = {
  github:
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
  twitter:
    "M23.95 4.57a9.6 9.6 0 0 1-2.75.75 4.8 4.8 0 0 0 2.1-2.65 9.6 9.6 0 0 1-3.04 1.16 4.79 4.79 0 0 0-8.16 4.37A13.6 13.6 0 0 1 1.67 3.15a4.79 4.79 0 0 0 1.48 6.4 4.78 4.78 0 0 1-2.17-.6v.06a4.79 4.79 0 0 0 3.84 4.69 4.8 4.8 0 0 1-2.16.08 4.79 4.79 0 0 0 4.47 3.32A9.6 9.6 0 0 1 1.18 19a13.5 13.5 0 0 0 7.33 2.15c8.8 0 13.6-7.28 13.6-13.6l-.01-.62A9.7 9.7 0 0 0 23.95 4.57Z",
  linkedin:
    "M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.8 0 0 .78 0 1.74v20.52C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.74C24 .78 23.2 0 22.22 0Z",
};

/* ---------------------------------------------------------------- features */

export const CORE_FEATURES: Feature[] = [
  {
    title: "Upload anything",
    body: "PDF, TXT, JSON, and CSV up to 25 MB. Files are processed in the background while you keep working.",
    icon: ICONS.upload,
    accent: "blue",
  },
  {
    title: "Semantic search",
    body: "Find answers across your documents with vector search — results ranked by meaning, not just keywords.",
    icon: ICONS.search,
    accent: "violet",
  },
  {
    title: "Ask your documents",
    body: "Get direct answers grounded in your own files, with source context. No more scanning pages by hand.",
    icon: ICONS.chat,
    accent: "green",
  },
];

export const SECONDARY_FEATURES: Feature[] = [
  {
    title: "Private by design",
    body: "Documents are isolated per user. Only you can search and ask questions about what you upload.",
    icon: ICONS.shield,
    accent: "blue",
  },
  {
    title: "Blazing fast",
    body: "An asynchronous worker pipeline plus Redis caching keep uploads, search, and answers snappy.",
    icon: ICONS.bolt,
    accent: "amber",
  },
  {
    title: "Bulk upload",
    body: "Drop in dozens of files at once. Every one is extracted, chunked, and embedded automatically.",
    icon: ICONS.bulk,
    accent: "violet",
  },
  {
    title: "Export results",
    body: "Download search results as CSV or JSON — formula-injection safe for safe spreadsheet sharing.",
    icon: ICONS.export,
    accent: "green",
  },
  {
    title: "Webhook notifications",
    body: "Get notified when documents finish processing, fail, or are deleted — sign with HMAC secrets.",
    icon: ICONS.webhook,
    accent: "rose",
  },
  {
    title: "Refresh-token rotation",
    body: "Sessions rotate on every refresh and revoke on sign-out, with server-side state so a stolen token cannot be replayed.",
    icon: ICONS.key,
    accent: "blue",
  },
];

/* ------------------------------------------------------------------- steps */

export const STEPS: Feature[] = [
  {
    title: "Upload",
    body: "Drop your documents into your workspace. Processing starts automatically.",
    icon: STEP_ICONS.upload,
    accent: "blue",
  },
  {
    title: "Search",
    body: "Find relevant passages in seconds with semantic search across all your files.",
    icon: STEP_ICONS.search,
    accent: "violet",
  },
  {
    title: "Ask",
    body: "Ask questions in plain language and get answers quoted from your own documents.",
    icon: STEP_ICONS.chat,
    accent: "green",
  },
];

/**
 * Stage-by-stage detail for `/how-it-works`. The three `STEPS` above are the
 * one-line summary the landing page shows; this is the same pipeline described
 * in enough detail to be useful to someone deciding whether to adopt it.
 */
export const PIPELINE_STAGES = [
  {
    title: "1. Upload",
    accent: "blue" as Accent,
    icon: ICONS.upload,
    summary: "You drop a file in. The request returns immediately.",
    detail:
      "An upload is validated, written to object storage under a path scoped to your user ID, and queued for background processing. The API never waits for extraction, so a 25 MB PDF returns the same way a 2 KB text file does — with the document in the pending state and a job in the queue.",
    facts: ["Up to 25 MB per file", "PDF, TXT, JSON, CSV", "Bulk upload supported"],
    outcome:
      "An instant confirmation and a document in the list — not a spinner you have to watch.",
  },
  {
    title: "2. Extract",
    accent: "violet" as Accent,
    icon: ICONS.search,
    summary: "A background worker pulls the text out of the file.",
    detail:
      "The worker reads the object back, extracts text according to the format (PDF text layers, plain text, structured JSON), and renders a first-page thumbnail for PDFs. A document that cannot be parsed is marked failed with the reason attached rather than retried silently forever.",
    facts: ["Asynchronous arq worker", "Failed documents surface the error", "PDF thumbnails rendered"],
    outcome:
      "Real text you can read back, plus a first-page preview so you can check the file landed correctly.",
  },
  {
    title: "3. Chunk",
    accent: "amber" as Accent,
    icon: ICONS.bulk,
    summary: "The text is split into passages that fit a model's context.",
    detail:
      "Long documents are split into overlapping chunks with their position and page metadata preserved. Chunking is what makes retrieval useful: a search result can point at a specific passage instead of a whole file, and an answer can quote the exact lines it came from.",
    facts: ["Overlapping windows", "Page + position metadata kept", "Chunk count visible per document"],
    outcome:
      "Answers that quote a specific passage and page, instead of paraphrasing a whole file.",
  },
  {
    title: "4. Embed",
    accent: "green" as Accent,
    icon: ICONS.bolt,
    summary: "Each chunk becomes a vector and is stored for search.",
    detail:
      "Every chunk is converted to an embedding and written to PostgreSQL through pgvector. This is the expensive step, which is exactly why it happens in the background: the API stays responsive while the vector index is built, and the document flips to ready only once its vectors are actually queryable.",
    facts: ["pgvector storage", "Batch embedding calls", "Document flips to ready when complete"],
    outcome:
      "A document marked ready, which is the honest signal that its text is genuinely searchable.",
  },
  {
    title: "5. Search",
    accent: "blue" as Accent,
    icon: ICONS.search,
    summary: "Your query is embedded too, then matched by meaning.",
    detail:
      "A search embeds the query and ranks chunks by vector distance, so 'how do I get a refund' finds a passage about returning an invoice even without shared keywords. Results are paginated and can be filtered to specific documents, and each result carries the source file it came from.",
    facts: ["Meaning-based ranking", "top_k + offset pagination", "Filter by document"],
    outcome:
      "The right passage, ranked by meaning — found by description, not by guessing keywords.",
  },
  {
    title: "6. Ask",
    accent: "violet" as Accent,
    icon: ICONS.chat,
    summary: "A language model answers using only your retrieved chunks.",
    detail:
      "For a question, the top chunks are retrieved first and passed to the model as grounding context, so answers are drawn from your documents rather than from memory. You choose the model, and on paid plans you can bring your own OpenAI or Groq key so the request never touches our credentials.",
    facts: ["Grounded in retrieved chunks", "OpenAI or Groq", "Bring your own key on Pro"],
    outcome:
      "A grounded answer with its sources attached, on the model you chose, using your key if you brought one.",
  },
];

/* ----------------------------------------------------------------- pricing */

export const PLANS = [
  {
    name: "Free",
    monthly: "$0",
    annual: "$0",
    period: "forever",
    cta: "Start free",
    featured: false,
  },
  {
    name: "Pro",
    monthly: "$12",
    annual: "$10",
    period: "per month",
    cta: "Go Pro",
    featured: true,
  },
  {
    name: "Enterprise",
    monthly: "Custom",
    annual: "Custom",
    period: "per team",
    cta: "Contact sales",
    featured: false,
  },
];

export type PlanCell = boolean | string;

export const COMPARISON_ROWS: {
  feature: string;
  free: PlanCell;
  pro: PlanCell;
  enterprise: PlanCell;
}[] = [
  { feature: "Documents per workspace", free: "20", pro: "Unlimited", enterprise: "Unlimited" },
  { feature: "Semantic search", free: true, pro: true, enterprise: true },
  { feature: "Ask your documents", free: "10 / month", pro: "Unlimited", enterprise: "Unlimited" },
  { feature: "Model choice", free: "Free model", pro: "All models", enterprise: "Custom models" },
  { feature: "Bring your own API key", free: false, pro: true, enterprise: true },
  { feature: "Export results (CSV & JSON)", free: false, pro: true, enterprise: true },
  { feature: "Bulk upload", free: true, pro: true, enterprise: true },
  { feature: "Webhook notifications", free: false, pro: true, enterprise: true },
  { feature: "PDF first-page thumbnails", free: true, pro: true, enterprise: true },
  { feature: "Q&A answer caching", free: false, pro: true, enterprise: true },
  { feature: "Search history", free: true, pro: true, enterprise: true },
  { feature: "Rate limits", free: "Standard", pro: "Higher", enterprise: "Custom" },
  { feature: "Roles & admin", free: false, pro: false, enterprise: true },
  { feature: "SSO & audit log", free: false, pro: false, enterprise: true },
  { feature: "Priority support", free: false, pro: false, enterprise: true },
];

/** Extended plan detail for `/pricing` — the reasoning behind each limit. */
export const PLAN_DETAILS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    blurb: "Enough to prove the idea works on your own documents.",
    includes: [
      "20 documents per workspace",
      "Unlimited semantic search",
      "10 questions per month",
      "One model, no bring-your-own-key",
      "Bulk upload and PDF thumbnails",
      "Standard rate limits",
    ],
  },
  {
    name: "Pro",
    price: "$12",
    period: "per month, billed annually ($10 monthly)",
    blurb: "For people who live in their document workspace all day.",
    includes: [
      "Unlimited documents",
      "Unlimited questions",
      "Every available Q&A model",
      "Bring your own OpenAI or Groq key",
      "CSV and JSON export of search results",
      "Webhook notifications with HMAC signing",
      "Answer caching and search history",
      "Higher rate limits",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "per team",
    blurb: "For organisations that need control over who sees what.",
    includes: [
      "Everything in Pro",
      "Role-based access control",
      "SSO and audit logging",
      "Custom model deployment",
      "Custom rate limits",
      "Priority support with a response target",
    ],
  },
];

export const FAQ_ITEMS = [
  {
    question: "Is there a free plan?",
    answer:
      "Yes. The Free plan is free forever and includes 20 documents, semantic search, and 10 questions per month. No credit card required.",
  },
  {
    question: "What file types can I upload?",
    answer:
      "PDF, TXT, JSON, and CSV up to 25 MB per file. Uploads are processed asynchronously — you can keep working while extraction and embeddings run.",
  },
  {
    question: "How does semantic search work?",
    answer:
      "Each document is split into chunks and converted into vector embeddings stored with pgvector. Search ranks results by meaning and relevance rather than keyword matches, so you find what you actually meant.",
  },
  {
    question: "Can I bring my own API key?",
    answer:
      "Yes. Pro and Enterprise plans support bring-your-own-key for the Q&A models, so your questions use your own OpenAI or Groq credentials.",
  },
  {
    question: "How is my data kept private?",
    answer:
      "Documents are isolated per user with object storage paths like /users/{owner-id}/documents. Search and Q&A are scoped to your own workspace, and exports are formula-injection safe.",
  },
];

/* -------------------------------------------------------------------- site */

export const SITE = {
  name: "AskDocs",
  tagline: "AI Document Intelligence Platform",
  description:
    "Upload files, search them semantically, and get grounded answers from your own knowledge base — in seconds.",
  repoUrl: "https://github.com/fiwon123/ai-document-platform",
  repoLabel: "github.com/fiwon123/ai-document-platform",
  email: "hello@askdocs.example",
  securityEmail: "security@askdocs.example",
  legalEmail: "legal@askdocs.example",
  /** Placeholder legal entity — replace before publishing the legal pages. */
  entity: "AskDocs",
  jurisdiction: "Ireland",
  updated: "25 September 2026",
} as const;

/**
 * Navigation.
 *
 * One definition, three consumers: the header dropdowns, the footer columns
 * and the hub pages. Adding a page here makes it appear in all of them, which
 * is why the header and footer cannot disagree about what exists.
 */
export const NAV_PRODUCT = [
  { label: "Features", to: "/features" },
  { label: "How it works", to: "/how-it-works" },
  { label: "Pricing", to: "/pricing" },
  { label: "Live demo", to: "/demo" },
];

/**
 * Company pages, in navigation order.
 *
 * The hub is the first entry rather than a separate concept (#584). It used to
 * be two things: a `hub: "/company"` prop the header and footer each turned
 * into their own link, labelled by composing `{label} overview` *in the navbar*,
 * and a hardcoded `Overview` in the footer. So "Company overview" was a string
 * that existed in a component, and "Overview" a string that existed in another,
 * for one page that had a label in neither `marketing.ts` — which is how the
 * header, the footer and the page could disagree about what the section is
 * called. It read as a different kind of thing from the four items below it.
 *
 * Being an entry is also what makes the label one value: the header menu, the
 * footer column, the 404 (which reads the footer) and the hub page all
 * iterate this array, so there is no call site left to forget.
 */
export const NAV_COMPANY = [
  { label: "General", to: "/company" },
  { label: "About", to: "/about" },
  { label: "Blog", to: "/blog" },
  { label: "Careers", to: "/careers" },
  { label: "Contact", to: "/contact" },
];

/* `NAV_LEGAL` used to live here, hand-written beside the four pages it pointed
   at. It now lives in `content/legal.ts` and is derived from the list of
   documents that actually exist (#618) — two lists that had to be kept in step
   by hand, and which could disagree without anything noticing. Import it from
   there. */

/** Every internal marketing route, for the sitemap and the routing test. */
export const MARKETING_ROUTES = [
  "/",
  "/product",
  "/features",
  "/how-it-works",
  "/pricing",
  "/demo",
  "/company",
  "/about",
  "/blog",
  "/careers",
  "/contact",
  "/privacy",
  "/terms",
  "/security",
  "/gdpr",
] as const;

/** Labels for `MARKETING_ROUTES`, used by the routing smoke test. */
export const MARKETING_ROUTE_LABELS: Record<(typeof MARKETING_ROUTES)[number], string> = {
  "/": "Find and ask anything",
  "/product": "Product",
  "/features": "Features",
  "/how-it-works": "How it works",
  "/pricing": "Pricing",
  "/demo": "Live demo",
  "/company": "Company",
  "/about": "About",
  "/blog": "Blog",
  "/careers": "Careers",
  "/contact": "Contact",
  "/privacy": "Privacy",
  "/terms": "Terms",
  "/security": "Security",
  "/gdpr": "GDPR",
};
