import { useState } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "../components/LandingNavbar";
import { Reveal } from "../components/Reveal";
import { ScreenshotCarousel } from "../components/landing/ScreenshotCarousel";
import { CountUp } from "../components/landing/CountUp";
import { FaqAccordion } from "../components/landing/FaqAccordion";
import { useAuth } from "../hooks/useAuth";

/* ------------------------------------------------------------------ icons */

function FeatureIcon({ path }: { path: string }) {
  return (
    <svg
      className="feature-icon"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS = {
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
};

const STEP_ICONS = {
  upload:
    "M12 16V4m0 0L7 9m5-5l5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  chat: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
};

function CheckIcon() {
  return (
    <svg
      className="compare-check"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-label="Included"
    >
      <path
        d="M20 6 9 17l-5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="compare-x"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-label="Not included"
    >
      <path
        d="M18 6 6 18M6 6l12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------- landing data */

const SCREENSHOTS = [
  {
    src: "/screenshots/dashboard.png",
    alt: "AskDocs dashboard with document statistics and recent uploads",
    caption: "Your workspace at a glance",
  },
  {
    src: "/screenshots/documents.png",
    alt: "Document library with upload controls and processing statuses",
    caption: "Upload and manage documents",
  },
  {
    src: "/screenshots/search.png",
    alt: "Semantic search results ranked by relevance",
    caption: "Semantic search across your files",
  },
  {
    src: "/screenshots/preview.png",
    alt: "Extracted text preview of a processed document",
    caption: "Read extracted content instantly",
  },
];

const LOGOS = ["Northwind", "Lumina", "Vertex Labs", "Bluepeak", "Tesseract"];

/** Accent palettes for feature/step cards. Each card reads its own accent
 *  from a data attribute (see App.css), so colors are defined once in CSS
 *  and applied per card in markup — no per-card inline styles. */
type Accent = "blue" | "violet" | "green" | "amber" | "rose";

type Feature = { title: string; body: string; icon: string; accent: Accent };

const CORE_FEATURES: Feature[] = [
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

const SECONDARY_FEATURES: Feature[] = [
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
];

const STEPS: Feature[] = [
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

const PLANS = [
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

type PlanCell = boolean | string;

const COMPARISON_ROWS: { feature: string; free: PlanCell; pro: PlanCell; enterprise: PlanCell }[] = [
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

function PlanCellValue({ value }: { value: PlanCell }) {
  if (value === true) return <CheckIcon />;
  if (value === false) return <XIcon />;
  return <>{value}</>;
}

const FAQ_ITEMS = [
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

const FOOTER_PRODUCT = [
  { label: "Features", to: "/#features" },
  { label: "How it works", to: "/#how-it-works" },
  { label: "Pricing", to: "/#pricing" },
  { label: "Live demo", to: "/demo" },
];

const FOOTER_COMPANY = [
  { label: "About", to: "/" },
  { label: "Blog", to: "/" },
  { label: "Careers", to: "/" },
  { label: "Contact", to: "/" },
];

const FOOTER_LEGAL = [
  { label: "Privacy", to: "/" },
  { label: "Terms", to: "/" },
  { label: "Security", to: "/" },
  { label: "GDPR", to: "/" },
];

function SocialLink({
  label,
  path,
  href = "/#",
  title,
  comingSoon = false,
}: {
  label: string;
  path: string;
  href?: string;
  title?: string;
  /** Placeholder for accounts we don't run yet — dimmed with a tooltip. */
  comingSoon?: boolean;
}) {
  return (
    <a
      className={`footer-social${comingSoon ? " coming-soon" : ""}`}
      href={href}
      aria-label={label}
      title={title}
      data-coming-soon={comingSoon ? "true" : undefined}
      target={comingSoon ? undefined : "_blank"}
      rel={comingSoon ? undefined : "noopener noreferrer"}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path d={path} fill="currentColor" />
      </svg>
    </a>
  );
}

const SOCIAL_PATHS = {
  github:
    "M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z",
  twitter:
    "M23.95 4.57a9.6 9.6 0 0 1-2.75.75 4.8 4.8 0 0 0 2.1-2.65 9.6 9.6 0 0 1-3.04 1.16 4.79 4.79 0 0 0-8.16 4.37A13.6 13.6 0 0 1 1.67 3.15a4.79 4.79 0 0 0 1.48 6.4 4.78 4.78 0 0 1-2.17-.6v.06a4.79 4.79 0 0 0 3.84 4.69 4.8 4.8 0 0 1-2.16.08 4.79 4.79 0 0 0 4.47 3.32A9.6 9.6 0 0 1 1.18 19a13.5 13.5 0 0 0 7.33 2.15c8.8 0 13.6-7.28 13.6-13.6l-.01-.62A9.7 9.7 0 0 0 23.95 4.57Z",
  linkedin:
    "M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.8 0 0 .78 0 1.74v20.52C0 23.22.8 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.74V1.74C24 .78 23.2 0 22.22 0Z",
};

const TRUST_BADGES = ["SOC 2 ready", "GDPR compliant", "Open source", "AES-256 at rest"];

/* ------------------------------------------------------------ landing page */

export function LandingPage() {
  const { user } = useAuth();
  const [annual, setAnnual] = useState(false);

  // Signed-in visitors don't need account-creation CTAs; point them back to
  // their workspace instead.
  const secondaryCta = user ? (
    <Link to="/app" className="btn btn-secondary btn-lg">
      Go to your workspace
    </Link>
  ) : (
    <Link to="/register" className="btn btn-secondary btn-lg">
      Create free account
    </Link>
  );

  const handleNewsletter = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("email") as HTMLInputElement;
    if (input?.value) {
      input.value = "";
    }
  };

  return (
    <div className="landing-page">
      <LandingNavbar />

      <header className="landing-hero">
        <div className="hero-mesh" aria-hidden="true" />
        <div className="landing-hero-inner">
          <Reveal variant="up">
            <p className="landing-eyebrow">AI Document Intelligence</p>
          </Reveal>
          <Reveal variant="up" delay={80}>
            <h1>
              Find and ask anything
              <br />
              in <span className="gradient-text">your documents.</span>
            </h1>
          </Reveal>
          <Reveal variant="up" delay={160}>
            <p className="landing-sub">
              Upload files, search them semantically, and get grounded answers
              from your own knowledge base — in seconds.
            </p>
          </Reveal>
          <Reveal variant="up" delay={240}>
            <div className="landing-ctas">
              <Link to="/demo" className="btn btn-primary btn-lg">
                Try the live demo
              </Link>
              {secondaryCta}
            </div>
            {!user && (
              <p className="landing-note">
                No credit card required. Try it without an account.
              </p>
            )}
          </Reveal>
        </div>

        <Reveal variant="scale" delay={200}>
          <div className="landing-preview">
            <div className="preview-window">
              <div className="preview-bar">
                <span />
                <span />
                <span />
                <span className="preview-url">askdocs.app</span>
              </div>
              <ScreenshotCarousel slides={SCREENSHOTS} label="AskDocs product screenshots" />
            </div>
          </div>
        </Reveal>
      </header>

      <section className="landing-social" aria-label="Social proof">
        <Reveal variant="up">
          <p className="trusted-by">Trusted by teams who ship</p>
          {/* The track is duplicated so the marquee can loop seamlessly by
              translating -50%. aria-hidden: purely decorative text marks. */}
          <div className="logo-marquee" aria-hidden="true">
            <div className="logo-strip">
              {[...LOGOS, ...LOGOS].map((logo, i) => (
                <span key={`${logo}-${i}`} className="logo-mark">
                  {logo}
                </span>
              ))}
            </div>
          </div>
          <div className="stat-row">
            <div className="stat-item">
              <strong className="stat-value">
                <CountUp value={12000} suffix="+" />
              </strong>
              <span>Documents processed</span>
            </div>
            <div className="stat-item">
              <strong className="stat-value">
                <CountUp value={48000} suffix="+" />
              </strong>
              <span>Questions answered</span>
            </div>
            <div className="stat-item">
              <strong className="stat-value">
                <CountUp value={99} suffix="%" />
              </strong>
              <span>Search uptime</span>
            </div>
          </div>
          <p className="stats-demo-note">
            Sample figures shown for illustration — your workspace shows your
            real numbers.
          </p>
          <ul className="trust-badges">
            {TRUST_BADGES.map((badge) => (
              <li key={badge}>
                <span className="trust-badge-check">
                  <CheckIcon />
                </span>
                {badge}
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      <section id="features" className="landing-section">
        <Reveal variant="up">
          <h2>Everything you need to know your documents</h2>
          <p className="landing-section-sub">
            From upload to grounded answers — one private workspace.
          </p>
        </Reveal>
        <Reveal variant="up" delay={60}>
          <h3 className="feature-category">Core capabilities</h3>
        </Reveal>
        <div className="landing-grid landing-grid-core">
          {CORE_FEATURES.map((feature, i) => (
            <Reveal key={feature.title} variant="up" delay={Math.min(i * 60, 120)}>
              <article
                className="landing-card landing-card-core card-hover"
                data-accent={feature.accent}
              >
                <FeatureIcon path={feature.icon} />
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <Reveal variant="up" delay={60}>
          <h3 className="feature-category feature-category-secondary">
            More to explore
          </h3>
        </Reveal>
        <div className="landing-grid landing-grid-secondary">
          {SECONDARY_FEATURES.map((feature, i) => (
            <Reveal key={feature.title} variant="up" delay={Math.min(i * 50, 200)}>
              <article className="landing-card card-hover" data-accent={feature.accent}>
                <FeatureIcon path={feature.icon} />
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="landing-section landing-section-alt">
        <Reveal variant="up">
          <h2>How it works</h2>
          <p className="landing-section-sub">Three steps from upload to answers.</p>
        </Reveal>
        <div className="landing-steps">
          {STEPS.map((item, i) => (
            <Reveal key={item.title} variant="up" delay={Math.min(i * 100, 200)}>
              <article className="landing-step" data-accent={item.accent}>
                <span className="landing-step-icon">
                  <svg
                    viewBox="0 0 24 24"
                    width="22"
                    height="22"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d={item.icon}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="landing-step-number">{i + 1}</span>
                </span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="pricing" className="landing-section">
        <Reveal variant="up">
          <h2>Pricing that grows with you</h2>
          <p className="landing-section-sub">
            Start free, upgrade when your team needs more.
          </p>
        </Reveal>

        <Reveal variant="up" delay={80}>
          <div className="billing-toggle">
            <span className={annual ? "" : "active"}>Monthly</span>
            <button
              type="button"
              role="switch"
              aria-checked={annual}
              aria-label="Toggle annual billing"
              className="toggle-switch"
              onClick={() => setAnnual((value) => !value)}
            >
              <span className="toggle-thumb" />
            </button>
            <span className={annual ? "active" : ""}>
              Annual <em className="save-badge">Save 17%</em>
            </span>
          </div>
        </Reveal>

        <div className="landing-plans">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} variant="up" delay={Math.min(i * 80, 160)}>
              <article
                className={`landing-plan card-hover${plan.featured ? " landing-plan-featured" : ""}`}
              >
                {plan.featured && <span className="plan-badge">Most Popular</span>}
                <h3>{plan.name}</h3>
                <p className="landing-price">
                  {annual ? plan.annual : plan.monthly}
                  {plan.period !== "forever" && <span>/ {plan.period}</span>}
                  {plan.period === "forever" && <span>{plan.period}</span>}
                </p>
                <Link
                  to={user ? "/app" : "/register"}
                  className={`btn ${plan.featured ? "btn-primary" : "btn-secondary"}`}
                >
                  {user ? "Open workspace" : plan.cta}
                </Link>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal variant="up">
          <div className="landing-table-wrap">
            <table className="landing-table">
              <thead>
                <tr>
                  <th>Compare plans</th>
                  {PLANS.map((plan) => (
                    <th
                      key={plan.name}
                      className={plan.featured ? "pro-head" : undefined}
                    >
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <tr key={row.feature}>
                    <td>{row.feature}</td>
                    <td>
                      <PlanCellValue value={row.free} />
                    </td>
                    <td className="pro-cell">
                      <PlanCellValue value={row.pro} />
                    </td>
                    <td>
                      <PlanCellValue value={row.enterprise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>

      <section id="faq" className="landing-section landing-section-alt">
        <Reveal variant="up">
          <h2>Frequently asked questions</h2>
          <p className="landing-section-sub">
            Everything else — just ask us.
          </p>
        </Reveal>
        <Reveal variant="up" delay={80}>
          <div className="faq-wrap">
            <FaqAccordion items={FAQ_ITEMS} />
          </div>
        </Reveal>
      </section>

      <section className="landing-cta-band">
        <Reveal variant="up">
          <h2>Ready to find answers in your documents?</h2>
          <div className="landing-ctas">
            <Link to="/demo" className="btn btn-primary btn-lg">
              Try the live demo
            </Link>
            {secondaryCta}
          </div>
        </Reveal>
      </section>

      <footer className="landing-footer">
        <form className="newsletter" onSubmit={handleNewsletter}>
          <div className="newsletter-copy">
            <strong>Stay in the loop</strong>
            <span>Product updates, once a month. No spam.</span>
          </div>
          <div className="newsletter-form">
            <input
              type="email"
              name="email"
              required
              placeholder="you@company.com"
              aria-label="Email address"
            />
            <button type="submit" className="btn btn-primary">
              Subscribe
            </button>
          </div>
        </form>

        <div className="footer-cols">
          <div className="footer-col footer-brand">
            <span className="footer-brand-name">AskDocs</span>
            <p>AI Document Intelligence Platform</p>
            <div className="footer-socials">
              <SocialLink
                label="AskDocs on GitHub"
                path={SOCIAL_PATHS.github}
                href="https://github.com/fiwon123/ai-document-platform"
                title="View source on GitHub"
              />
              <SocialLink
                label="AskDocs on Twitter"
                path={SOCIAL_PATHS.twitter}
                title="Coming soon"
                comingSoon
              />
              <SocialLink
                label="AskDocs on LinkedIn"
                path={SOCIAL_PATHS.linkedin}
                title="Coming soon"
                comingSoon
              />
            </div>
          </div>
          <nav className="footer-col" aria-label="Product">
            <strong>Product</strong>
            {FOOTER_PRODUCT.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
          <nav className="footer-col" aria-label="Company">
            <strong>Company</strong>
            {FOOTER_COMPANY.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
          <nav className="footer-col" aria-label="Legal">
            <strong>Legal</strong>
            {FOOTER_LEGAL.map((item) => (
              <Link key={item.label} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} AskDocs</span>
          <span>Made for people who love their documents.</span>
        </div>
      </footer>
    </div>
  );
}