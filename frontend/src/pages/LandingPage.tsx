import { Link } from "react-router-dom";
import { LandingNavbar } from "../components/LandingNavbar";
import { useAuth } from "../hooks/useAuth";

const FEATURES = [
  {
    title: "Upload anything",
    body: "PDF, TXT, JSON, and CSV up to 25 MB. Files are processed in the background while you keep working.",
  },
  {
    title: "Semantic search",
    body: "Find answers across your documents with vector search — results ranked by meaning, not just keywords.",
  },
  {
    title: "Ask your documents",
    body: "Get direct answers grounded in your own files, with source context. No more scanning pages by hand.",
  },
  {
    title: "Private by design",
    body: "Documents are isolated per user. Only you can search and ask questions about what you upload.",
  },
];

const STEPS = [
  {
    step: "1",
    title: "Upload",
    body: "Drop your documents into your workspace. Processing starts automatically.",
  },
  {
    step: "2",
    title: "Search",
    body: "Find relevant passages in seconds with semantic search across all your files.",
  },
  {
    step: "3",
    title: "Ask",
    body: "Ask questions in plain language and get answers quoted from your own documents.",
  },
];

const PLANS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    cta: "Start free",
    to: "/register",
    featured: false,
  },
  {
    name: "Pro",
    price: "$12",
    period: "per month",
    cta: "Go Pro",
    to: "/register",
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "per team",
    cta: "Contact sales",
    to: "/register",
    featured: false,
  },
];

const COMPARISON_ROWS: {
  feature: string;
  free: string;
  pro: string;
  enterprise: string;
}[] = [
  { feature: "Documents per workspace", free: "20", pro: "Unlimited", enterprise: "Unlimited" },
  { feature: "Semantic search", free: "✓", pro: "✓", enterprise: "✓" },
  { feature: "Ask your documents", free: "10 / month", pro: "Unlimited", enterprise: "Unlimited" },
  { feature: "Model choice", free: "Free model", pro: "All models", enterprise: "Custom models" },
  { feature: "Bring your own API key", free: "—", pro: "✓", enterprise: "✓" },
  { feature: "Export & collaboration", free: "—", pro: "✓", enterprise: "✓" },
  { feature: "SSO & priority support", free: "—", pro: "—", enterprise: "✓" },
];

export function LandingPage() {
  const { user } = useAuth();
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

  return (
    <div className="landing-page">
      <LandingNavbar />

      <header className="landing-hero">
        <div className="landing-hero-inner">
          <p className="landing-eyebrow">AI Document Intelligence</p>
          <h1>
            Find and ask anything
            <br />
            in your documents.
          </h1>
          <p className="landing-sub">
            Upload files, search them semantically, and get grounded answers
            from your own knowledge base — in seconds.
          </p>
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
        </div>

        <div className="landing-preview" aria-hidden="true">
          <div className="preview-window">
            <div className="preview-bar">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-body">
              <div className="preview-side">
                <div className="preview-nav-item" />
                <div className="preview-nav-item" />
                <div className="preview-nav-item" />
                <div className="preview-nav-item" />
              </div>
              <div className="preview-main">
                <div className="preview-card">
                  <div className="preview-line w80" />
                  <div className="preview-line w60" />
                </div>
                <div className="preview-card">
                  <div className="preview-line w90" />
                  <div className="preview-line w70" />
                </div>
                <div className="preview-card">
                  <div className="preview-line w75" />
                  <div className="preview-line w55" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section id="features" className="landing-section">
        <h2>Everything you need to know your documents</h2>
        <div className="landing-grid">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="landing-card">
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="landing-section landing-section-alt">
        <h2>How it works</h2>
        <div className="landing-steps">
          {STEPS.map((item) => (
            <article key={item.step} className="landing-step">
              <span className="landing-step-number">{item.step}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="pricing" className="landing-section">
        <h2>Pricing that grows with you</h2>
        <p className="landing-section-sub">
          Start free, upgrade when your team needs more.
        </p>

        <div className="landing-plans">
          {PLANS.map((plan) => (
            <article
              key={plan.name}
              className={`landing-plan${plan.featured ? " landing-plan-featured" : ""}`}
            >
              <h3>{plan.name}</h3>
              <p className="landing-price">
                {plan.price}
                <span>{plan.period}</span>
              </p>
              <Link
                to={user ? "/app" : plan.to}
                className={`btn ${plan.featured ? "btn-primary" : "btn-secondary"}`}
              >
                {user ? "Open workspace" : plan.cta}
              </Link>
            </article>
          ))}
        </div>

        <div className="landing-table-wrap">
          <table className="landing-table">
            <thead>
              <tr>
                <th>Compare plans</th>
                {PLANS.map((plan) => (
                  <th key={plan.name}>{plan.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td>{row.free}</td>
                  <td>{row.pro}</td>
                  <td>{row.enterprise}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="landing-cta-band">
        <h2>Ready to find answers in your documents?</h2>
        <div className="landing-ctas">
          <Link to="/demo" className="btn btn-primary btn-lg">
            Try the live demo
          </Link>
          {secondaryCta}
        </div>
      </section>

      <footer className="landing-footer">
        <span className="landing-footer-brand">AskDocs</span>
        <span>AI Document Intelligence Platform</span>
        <span className="landing-footer-copy">
          © {new Date().getFullYear()} AskDocs
        </span>
      </footer>
    </div>
  );
}