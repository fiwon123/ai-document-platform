export interface DemoSampleDoc {
  id: string;
  filename: string;
  mime_type: string;
  status: "ready";
  /** One line: what is in the document and what it is there to demonstrate. */
  description: string;
  chunks: string[];
}

/** Pre-seeded sample documents, mocked locally — no API calls in demo mode. */
export const DEMO_DOCUMENTS: DemoSampleDoc[] = [
  {
    id: "demo-company-handbook",
    filename: "company-handbook.pdf",
    mime_type: "application/pdf",
    status: "ready",
    description:
      "Benefits, remote-work policy and security rules — the best document to ask a policy question about.",
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
    description:
      "A day-one, week-one and first-sprint walkthrough — try it for time-bound questions like “what happens on day one?”",
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
    description:
      "Design tokens, spacing scale and component rules — the best document for questions about exact values.",
    chunks: [
      "The design system is built on tokens. Color tokens include ink, paper, surface, muted, line, blue, and green, with dark-theme variants.",
      "Spacing uses a 4px base scale: 4, 8, 12, 16, 24, 32, 48, and 64. Use tokens instead of magic numbers so dark mode stays consistent.",
      "Buttons come in three variants: primary for the main action, secondary for alternatives, and danger for destructive edits. Always disable loading buttons.",
      "Forms use accessible labels with the .form-group wrapper, and inputs show a blue focus ring. Error messages use the danger tokens and role=\"alert\".",
      "Everything ships with reduced-motion support and prefers-color-scheme. Run the axe scan in CI before merging any UI change.",
    ],
  },
];