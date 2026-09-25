import { LegalDocument, type LegalSection } from "../components/LegalDocument";
import { SITE } from "../content/marketing";

const SECTIONS: LegalSection[] = [
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
];

export function SecurityPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title="Security"
      intro="How the platform is built to protect documents — the controls that are actually implemented, and the ones that are not yet."
      sections={SECTIONS}
    />
  );
}
