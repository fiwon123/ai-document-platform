import { SITE } from "./marketing";

/**
 * Every legal document the site publishes, in one place.
 *
 * ## Why this is one file
 *
 * These four documents were the only copy on the site that lived somewhere
 * other than a content module: each page component owned its own `SECTIONS`
 * array, so the text a lawyer has to review was scattered across four `.tsx`
 * files. That is the one thing `marketing.ts` exists to prevent — it is the
 * single source for marketing copy, navigation, the route list and pricing,
 * and its value is that the header, the footer, the hub pages and the routing
 * test cannot disagree about what exists. Legal copy broke that rule, and
 * nothing could assert the four documents even shared a shape.
 *
 * So: every section of all four documents is here, `NAV_LEGAL` is derived from
 * this same list rather than maintained beside it, and each page file is a thin
 * wrapper that looks its document up by route. Consequences:
 *
 * - The copy is reviewable as legal text rather than as React.
 * - The footer column and the pages that exist cannot drift apart, because they
 *   are the same array.
 * - The shared section shape is enforced once, here, instead of being an
 *   implicit convention across four files.
 * - Adding a document is one entry here plus one route in `App.tsx` — not a new
 *   page file, a `marketing.ts` edit and a footer edit.
 *
 * Routes, titles, intros and section order are all unchanged by this move. So
 * are the pages' URLs, which may already be shared or indexed.
 *
 * ## Before publishing
 *
 * These are realistic templates, not reviewed legal documents, and every page
 * says so in a visible `TemplateNotice`. `SITE` still holds placeholders that
 * have to be replaced first — the entity name, the jurisdiction, and the
 * `*.example` contact addresses — and the processor/subprocessor lists,
 * retention periods and governing-law clauses need a qualified lawyer's eye.
 * See `AGENTS.md` → *Before publishing the legal pages*.
 */

export type LegalSection = {
  heading: string;
  /** One or more paragraphs. An array so a section can split content into
   *  lead + detail without nesting markup in the content module. */
  body: string[];
  /** Optional bullet list rendered under the paragraphs. */
  items?: string[];
};

export type LegalDocumentDefinition = {
  /** The public route. Also the key `legalDocument()` looks up. */
  route: string;
  /** Short label for navigation — the footer column and the legal hub. */
  label: string;
  /** The page's `h1`. */
  title: string;
  /** Hero subtitle. */
  intro: string;
  sections: LegalSection[];
};

const PRIVACY_DOCUMENT: LegalDocumentDefinition = {
  route: "/privacy",
  label: "Privacy",
  title: "Privacy Policy",
  intro:
    "What personal data the service handles, why it handles it, and what you can do about it.",
  sections: [
] = [
{
  heading: "Who we are",
  body: [
    `${SITE.entity} ("we", "us") operates the ${SITE.name} document intelligence platform. This policy explains what personal data the service handles, why, and what we do with it.`,
    "It applies to the hosted service and to this website. It does not cover documents you upload to a workspace you control beyond describing our own processing of them — you remain the controller of your content.",
  ],
},
{
  heading: "Data we process",
  body: ["We process the following categories of personal data, either on your behalf or to operate the service."],
  items: [
    "Account data: username, password hash, role, account status, and timestamps.",
    "Session data: access tokens and rotating refresh tokens. Refresh tokens are stored as hashes and can be revoked.",
    "Content you upload: the files, the extracted text, the derived chunks and vector embeddings, and any preview images rendered from them.",
    "Usage data: search queries, result counts, and question/answer pairs you submit, used to operate the workspace and to cache responses.",
    "Technical data: request metadata retained for security and rate-limiting purposes, including IP address where required to enforce limits.",
  ],
},
{
  heading: "Why we process it",
  body: [
    "Account data exists to authenticate you and to apply plan limits. Content data exists to provide the features you asked for: search and question answering cannot work without indexing the documents you uploaded. Usage data exists to answer your questions and to cache repeated queries so responses are fast.",
    "We do not use your documents to train models, and we do not sell personal data to anyone.",
  ],
},
{
  heading: "Legal bases",
  body: [
    "Where the GDPR applies, we rely on the following bases: performance of a contract for data needed to run your workspace; legitimate interests for security, rate limiting, and abuse prevention; and consent for marketing email, which you can withdraw at any time.",
    "Where we rely on legitimate interests, those interests are operating and protecting the service. You have the right to object — see the GDPR page.",
  ],
},
{
  heading: "Processors and sub-processors",
  body: [
    "We use subprocessors to provide infrastructure services. The current list, which must be kept accurate and published before this policy goes live, includes:",
  ],
  items: [
    "A managed PostgreSQL provider, used for account data, document metadata, chunks, and vector embeddings.",
    "An S3-compatible object storage provider, used to store uploaded files under a per-user key prefix.",
    "A managed Redis provider, used for caching, rate limiting, and the job queue.",
    "An application hosting provider, used to run the API and the background worker.",
    "Model providers, listed by the job each performs. Embeddings — the vectors built from your document text — are generated by OpenAI only. Question answering may use OpenAI, Groq, or a local model server you run yourself, and only the provider actually used for a given question receives the retrieved passages. If you supply your own API key, the request is made with your credentials and does not use ours.",
  ],
},
{
  heading: "Retention",
  body: [
    "Account and session data is retained for the life of the account and deleted shortly after closure. Content you upload is retained until you delete the document or close the account, and is then removed from storage and from the vector index.",
    "Security logs are retained for a limited period for investigation, after which they are deleted. Cached responses are invalidated when the underlying documents change.",
  ],
},
{
  heading: "Security",
  body: [
    "We apply the measures described on the Security page, including per-user isolation of stored objects, encryption in transit, and access controls. No system is perfectly secure, but the design assumes documents are sensitive and treats isolation as a property of the data model rather than a filter applied at query time.",
  ],
},
{
  heading: "Your rights",
  body: [
    "Depending on where you live, you may have the right to access your personal data, correct it, delete it, restrict or object to processing, receive it in a portable form, and withdraw consent. You can exercise most of these directly in the workspace — for example, deleting an uploaded document removes it from storage and the index.",
    `Requests that the interface cannot satisfy can be sent to ${SITE.legalEmail}. We respond within the timeframes the applicable law requires.`,
  ],
},
{
  heading: "International transfers",
  body: [
    "Our infrastructure providers may process data outside your country, including in the United States. Where data is transferred out of the EEA or UK we rely on the relevant safeguards, such as Standard Contractual Clauses, and we will say so here with the specific providers involved before this policy is published.",
  ],
},
{
  heading: "Children",
  body: [
    "The service is intended for businesses and adults. We do not knowingly collect data from children, and we delete it if we discover that we have.",
  ],
},
{
  heading: "Changes and contact",
  body: [
    "If this policy changes materially we will update the date above and, for account holders, notify them through the product. Questions, requests, and complaints are welcome at the addresses on the Contact page.",
  ],
},
  ],
};

const TERMS_DOCUMENT: LegalDocumentDefinition = {
  route: "/terms",
  label: "Terms",
  title: "Terms of Service",
  intro:
    "The agreement covering use of the platform, and the limits of what the service promises.",
  sections: [
] = [
{
  heading: "Agreement to these terms",
  body: [
    `These terms govern your use of the ${SITE.name} service and website. By creating an account or using the service you accept them. If you are accepting on behalf of an organisation, you confirm you have authority to bind it.`,
    "Where these terms conflict with a separate written agreement you have with us, that agreement wins for the scope it covers.",
  ],
},
{
  heading: "The service",
  body: [
    "AskDocs provides a workspace in which you may upload documents, search them semantically, and ask questions answered from their contents. Features and limits depend on your plan and may change; the Pricing page describes the current position.",
    "We may add, change, or remove features. We will not reduce the core functionality of a paid plan during its term without giving you notice and a refund option.",
  ],
},
{
  heading: "Your account",
  body: [
    "You are responsible for keeping your credentials confidential and for activity under your account. Tell us promptly if you believe someone else has access to it.",
    "You must be old enough to enter a contract where you live, and you may not create an account on behalf of someone else without their authority.",
  ],
},
{
  heading: "Your content",
  body: [
    "You keep all rights to the documents you upload. You grant us only the rights needed to operate the service for you: to store, process, index, and display that content to you and to answer your queries.",
    "You are responsible for having the right to upload what you upload, and for the lawfulness of that content. We do not claim ownership of your documents.",
    "We do not use your content to train models.",
  ],
},
{
  heading: "Acceptable use",
  body: ["You agree not to use the service to:"],
  items: [
    "Upload content you do not have the right to process, or that infringes someone else's rights.",
    "Store or distribute malware, or use the service to attack, probe, or disrupt it or any third party.",
    "Attempt to access another user's workspace, documents, or account.",
    "Circumvent plan limits, rate limits, or technical restrictions, including by automated means.",
    "Resell or provide the service to third parties as a substitute for our own, without a separate agreement.",
  ],
},
{
  heading: "Availability and support",
  body: [
    "We aim for high availability but do not guarantee uninterrupted service. We may suspend the service for maintenance, and we will restore it as soon as reasonably practicable.",
    "Support response times differ by plan and are described on the Pricing page. Enterprise customers should use their support channel rather than the public ones.",
  ],
},
{
  heading: "Suspension and termination",
  body: [
    "You may close your account at any time, which deletes your content as described in the Privacy Policy.",
    "We may suspend or terminate an account that breaches these terms, that puts the service at risk, or that we are required to act on by law. Where a suspension is not urgent or the account is paid for, we will normally warn you first and give an opportunity to fix the problem.",
  ],
},
{
  heading: "Our warranties and liability",
  body: [
    "The service is provided as is. We do not warrant that it will be uninterrupted, error-free, or fit for a particular purpose, and we do not warrant that generated answers are accurate — they are produced by a model from retrieved content and can be wrong.",
    "Nothing in these terms limits liability that cannot lawfully be limited. Subject to that, neither party is liable for indirect or consequential loss, and each party's total liability is limited to the amounts paid to us for the service in the twelve months before the claim.",
  ],
},
{
  heading: "Your content risk",
  body: [
    "The service is designed to be private per workspace, but no system is perfectly secure. Keep your own copies of anything you cannot afford to lose, and review the Security page before relying on it for material you cannot replace.",
  ],
},
{
  heading: "Changes, law, and contact",
  body: [
    "We may update these terms. Material changes take effect on the updated date above, and we will notify account holders through the product before they take effect.",
    `These terms are governed by the laws of ${SITE.jurisdiction}, and the courts of ${SITE.jurisdiction} have exclusive jurisdiction — this clause must be confirmed with a lawyer before publication. Questions go to ${SITE.legalEmail}.`,
  ],
},
  ],
};

const SECURITY_DOCUMENT: LegalDocumentDefinition = {
  route: "/security",
  label: "Security",
  title: "Security",
  intro:
    "How the platform is built to protect documents — the controls that are actually implemented, and the ones that are not yet.",
  sections: [
] = [
{
  heading: "How we think about security",
  body: [
    "Documents are business records, and the design treats them that way. The guiding rule is that isolation and provenance should be properties of the data model, not conventions that depend on remembering to add a filter. If a control only works when every query remembers it, it is not a control.",
  ],
},
{
  heading: "Per-workspace isolation",
  body: [
    "Every uploaded object is stored under a key that includes the owning account, and every query for chunks, previews, downloads, or thumbnails filters on that owner. Identifiers are UUIDs rather than sequential integers, so they cannot be guessed by incrementing.",
    "Ownership is re-checked on each request rather than inferred from the client, so a valid document ID belonging to another account returns nothing.",
  ],
},
{
  heading: "Authentication",
  body: [
    "Passwords are hashed with a memory-hard algorithm and never stored or logged in plaintext. Sessions use short-lived access tokens with rotating refresh tokens; refresh tokens are stored hashed, can be revoked individually, and are rotated on use, so a stolen token has a short window and reuse is detectable.",
    "Administrative actions — role changes, account activation, deletion — are restricted to accounts with the admin role and are auditable.",
  ],
},
{
  heading: "Encryption",
  body: [
    "All traffic is encrypted in transit with TLS, and object storage relies on provider-side encryption at rest. Database and cache access is restricted to the application network and protected by credentials held outside the repository.",
  ],
},
{
  heading: "The model boundary",
  body: [
    "Questions and documents are sent to a model provider to produce embeddings and answers. On paid plans you can supply your own API key, in which case that request is made with your credentials and does not use ours — this is the strongest control available for the model step.",
    "We do not use your content to train models. Where we act as a processor for a model provider, that is described in the Privacy Policy and GDPR pages.",
  ],
},
{
  heading: "Input validation and safe output",
  body: [
    "Uploads are validated for type and size before storage. Search and export results are sanitised so that spreadsheets cannot be tricked into executing formulas from document content — a document is untrusted input, and anything derived from it is treated the same way.",
    "Webhook deliveries to customer-supplied URLs are signed with an HMAC secret so receivers can verify authenticity, and payloads are delivered over HTTPS with bounded retries.",
  ],
},
{
  heading: "Rate limiting and abuse prevention",
  body: [
    "Requests are rate limited per account, and client addresses are derived from proxy headers only from trusted proxies. Limits exist to protect availability and to make bulk abuse expensive, not to police normal use.",
  ],
},
{
  heading: "Infrastructure and operations",
  body: [
    "The platform runs as a containerised stack with health checks, resource limits, and rolling updates. Databases are backed up on a schedule and restores are tested. Application and infrastructure logs are collected centrally so that access to production systems is itself auditable.",
    "Secrets are supplied to running services through a secrets manager rather than baked into images or committed to the repository.",
  ],
},
{
  heading: "Reporting a vulnerability",
  body: [
    `Report suspected vulnerabilities privately to ${SITE.securityEmail} rather than in a public issue. We will acknowledge a report, keep you updated, and give a reasonable window to ship a fix before any public disclosure. We ask that you avoid accessing other users' data while testing.`,
  ],
},
{
  heading: "Status and disclosure",
  body: [
    "We do not yet hold a SOC 2 Type II report. The controls described here are the ones actually implemented in the codebase and its infrastructure; treat this page as a description of the current state, not a certification. Where a control is aspirational it is marked as such rather than listed as done.",
  ],
},
  ],
};

const GDPR_DOCUMENT: LegalDocumentDefinition = {
  route: "/gdpr",
  label: "GDPR",
  title: "GDPR",
  intro:
    "How the platform handles personal data under the GDPR, in plain language.",
  sections: [
] = [
{
  heading: "Scope",
  body: [
    "This page summarises how the service handles personal data in relation to the GDPR and equivalent regimes. It is a summary in plain language; the enforceable obligations sit in the Privacy Policy and in the data processing agreement we sign with business customers.",
    `Nothing here is legal advice, and the roles described below must be confirmed against how ${SITE.entity} is actually contracted before this page is published.`,
  ],
},
{
  heading: "Controller and processor",
  body: [
    "For account data — username, password hash, role, session state — we are the controller: we decide why it is collected and how long it is kept.",
    "For documents you upload to a workspace, and for the chunks, embeddings, and answers derived from them, you are the controller and we are the processor. That means you decide what is uploaded and why, and our job is to process it only on your instructions.",
    "Where a business customer signs a data processing agreement, that agreement defines our obligations as processor in detail, including subprocessor approval.",
  ],
},
{
  heading: "Lawful basis",
  body: [
    "Account and session data: performance of a contract with you. Security and rate-limiting data: our legitimate interests in operating and protecting the service. Your documents and derived data: performance of the contract, on your instruction. Marketing email: consent, withdrawable at any time.",
    "We do not rely on legitimate interests for the content of your documents. If you ask us to delete it, we delete it.",
  ],
},
{
  heading: "Your rights",
  body: ["Where the GDPR applies you have the right to:"],
  items: [
    "be informed about how your data is used (Articles 13–14)",
    "access a copy of your personal data (Article 15)",
    "correct inaccurate data (Article 16)",
    "request erasure (Article 17)",
    "restrict processing (Article 18)",
    "receive data in a portable, machine-readable form (Article 20)",
    "object to processing based on legitimate interests (Article 21)",
    "withdraw consent at any time where consent is the basis",
    "lodge a complaint with your supervisory authority (Article 77)",
  ],
},
{
  heading: "How to exercise them",
  body: [
    "Most rights can be exercised directly in the workspace. Deleting a document removes the file from object storage and its chunks from the vector index. Closing the account removes account data and, as described in the Privacy Policy, the content associated with it.",
    `Requests the interface cannot satisfy — access requests spanning many documents, for example — go to ${SITE.legalEmail}. We respond within one month, extendable by two further months for complex requests, and we will tell you if we need to verify your identity first.`,
  ],
},
{
  heading: "Automated decision-making",
  body: [
    "The service does not make decisions with legal or similarly significant effects about you. Semantic ranking and generated answers are automated, but they produce search results and text, not decisions about a person, and nothing in the product is intended to be used that way.",
    "Answers are produced by a model and can be wrong. The Privacy Policy and Terms both say so explicitly, because an inaccurate answer presented as authoritative is a risk to you, not just an inconvenience.",
  ],
},
{
  heading: "International transfers",
  body: [
    "Our infrastructure and model providers may process data outside the EEA and UK. Where that happens we rely on an appropriate transfer mechanism, such as the Standard Contractual Clauses, and we will publish the specific providers and locations here once they are confirmed.",
    "The Privacy Policy lists the subprocessors we rely on. That list is the authoritative version and must be kept current.",
  ],
},
{
  heading: "Breach notification",
  body: [
    "If we become aware of a personal data breach we will notify the supervisory authority within 72 hours where the threshold is met, and notify affected users without undue delay where the breach is likely to result in a high risk to them.",
    "As a processor, our obligation is to notify the controller without undue delay so that the notification clock can be met. The specific timing agreed in the data processing agreement should be stated explicitly before signing.",
  ],
},
{
  heading: "Data minimisation and retention",
  body: [
    "We collect what the features need and no more. Search queries and question/answer pairs are retained because they are the queries themselves; they are not used to build advertising profiles or to train models.",
    "Retention periods are listed in the Privacy Policy. Data is deleted or anonymised when it is no longer needed, and deletion of a document propagates to derived data rather than leaving embeddings behind.",
  ],
},
{
  heading: "Complaints",
  body: [
    `If you are unhappy with how we handle your data, raise it with us first at ${SITE.legalEmail} so we can investigate. If the outcome does not satisfy you, you have the right to complain to the data protection authority in your country of residence, place of work, or the place of the alleged infringement.`,
  ],
},
  ],
};

/**
 * The four documents, in footer order.
 *
 * One list, three consumers: the footer column, `NAV_LEGAL` below, and the
 * pages themselves. Adding a document here makes it appear in all of them.
 */
export const LEGAL_DOCUMENTS: LegalDocumentDefinition[] = [
  PRIVACY_DOCUMENT,
  TERMS_DOCUMENT,
  SECURITY_DOCUMENT,
  GDPR_DOCUMENT,
];

/**
 * Navigation for the legal section, derived from the documents themselves.
 *
 * It used to be a hand-written list of `{ label, to }` beside the four pages
 * that actually exist — two lists that had to be kept in step by hand, and
 * which could disagree without anything noticing. Deriving it means a document
 * added above appears in the footer automatically, and one removed disappears.
 */
export const NAV_LEGAL = LEGAL_DOCUMENTS.map(({ label, route }) => ({
  label,
  to: route,
}));

/**
 * The document served at `route`.
 *
 * Throws rather than returning a fallback: the only caller is a page component
 * whose route was written by hand, so a miss means a route points at a document
 * that does not exist, and returning the first document instead would publish
 * the Privacy Policy at `/terms` — a wrong legal document under a real URL,
 * which is worse than a crash in development.
 */
export function legalDocument(route: string): LegalDocumentDefinition {
  const found = LEGAL_DOCUMENTS.find((doc) => doc.route === route);
  if (!found) {
    throw new Error(
      `No legal document defined for "${route}". Known: ${LEGAL_DOCUMENTS.map((d) => d.route).join(", ")}`,
    );
  }
  return found;
}

/** Convenience for the pages: the document for a route, looked up once. */
export function legalDocumentProps(route: string) {
  const { title, intro, sections } = legalDocument(route);
  return {
    // Every legal page files itself under the same section eyebrow. It is one
    // string here rather than repeated in four wrappers, so it cannot end up
    // spelled four ways.
    eyebrow: "Legal",
    title,
    intro,
    sections,
  };
}
