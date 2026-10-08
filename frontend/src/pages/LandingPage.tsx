import { useState } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "../components/LandingNavbar";
import { LandingFooter } from "../components/LandingFooter";
import { Reveal } from "../components/Reveal";
import { ScreenshotCarousel } from "../components/landing/ScreenshotCarousel";
import { CountUp } from "../components/landing/CountUp";
import { FaqAccordion } from "../components/landing/FaqAccordion";
import { PlanComparison } from "../components/landing/PlanComparison";
import { BillingToggle } from "../components/landing/BillingToggle";
import { PlanPrice } from "../components/landing/PlanPrice";
import { FlowIllustration } from "../components/landing/FlowIllustration";
import { RevealCard } from "../components/landing/RevealCard";
import { CheckIcon, FeatureIcon } from "../components/landing/FeatureIcon";
import { useAuth } from "../hooks/useAuth";
import { CORE_FEATURES, SECONDARY_FEATURES, STEPS, PLANS, FAQ_ITEMS } from "../content/marketing";

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

const LOGOS = ["Northwind", "Lumina", "Vertex Labs", "Bluepeak", "Tesseract", "mina"];

/* Claim strip under the stats. Phrased as targets rather than certifications —
   a badge that overstates what has been audited is worse than no badge, and the
   Security page is explicit that SOC 2 is not yet held. */
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

  return (
    <div className="landing-page">
      <LandingNavbar />

      <main className="landing-main">
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
                Upload files, search them semantically, and get grounded answers from your own
                knowledge base — in seconds.
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
                <p className="landing-note">No credit card required. Try it without an account.</p>
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
            {/* Three copies of the logo list so the marquee can loop seamlessly by
                translating -33.333%: each cycle advances exactly one copy. With
                two copies at -50% the reset was a half-track jump and two copy
                boundaries were often on screen together, which made the row read
                as one image tearing rather than as separate tags.
                aria-hidden: purely decorative text marks. */}
            <div className="logo-marquee forced-dark" aria-hidden="true">
              <div className="logo-strip">
                {[...LOGOS, ...LOGOS, ...LOGOS].map((logo, i) => (
                  <span key={`${logo}-${i}`} className="logo-mark">
                    {logo}
                  </span>
                ))}
              </div>
            </div>
            {/* Each stat carries its own data-accent so the number picks up the
                same accent palette the feature/step cards use (see App.css
                [data-accent]) instead of one shared gradient. Documents = blue,
                questions = violet, uptime = green, so the three read as a set
                rather than as three copies of the same figure.

                durationMs is staggered 1750 / 2000 / 2250 on purpose. All three
                scroll into view together and start counting together; giving the
                leftmost the shortest run means the row completes left to right.
                The easing is symmetric, so a shorter duration is a genuinely
                earlier arrival rather than a different-looking path. Combined
                with the 1.12em "still counting" size in App.css, the viewer sees
                the left figure settle and shrink back first, then the middle,
                then the right — the eye is walked across the row instead of
                being handed three numbers that all land at once.

                Do not close this gap much further: under ~150ms the three
                completions blur back into a single event, and the stagger stops
                reading as an ordered sequence. */}
            <div className="stat-row">
              <div className="stat-item" data-accent="blue">
                <strong className="stat-value">
                  <CountUp value={12000} suffix="+" durationMs={1750} />
                </strong>
                <span>Documents processed</span>
              </div>
              <div className="stat-item" data-accent="violet">
                <strong className="stat-value">
                  <CountUp value={48000} suffix="+" durationMs={2000} />
                </strong>
                <span>Questions answered</span>
              </div>
              <div className="stat-item" data-accent="green">
                <strong className="stat-value">
                  <CountUp value={99} suffix="%" durationMs={2250} />
                </strong>
                <span>Search uptime</span>
              </div>
            </div>
            <p className="stats-demo-note">
              Sample figures shown for illustration — your workspace shows your real numbers.
            </p>
            <ul className="trust-badges forced-dark">
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
          <div className="landing-grid landing-grid-core forced-dark">
            {CORE_FEATURES.map((feature, i) => (
              <RevealCard
                key={feature.title}
                className="landing-card landing-card-core card-hover"
                accent={feature.accent}
                delay={Math.min(i * 60, 120)}
              >
                <FeatureIcon path={feature.icon} />
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </RevealCard>
            ))}
          </div>
          <Reveal variant="up" delay={60}>
            <h3 className="feature-category feature-category-secondary">More to explore</h3>
          </Reveal>
          {/* RevealCard rather than Reveal: a Reveal wrapper box would collapse each
              card back to its own content height and leave the row's bottom edge
              stepping by the difference (24px, measured). See RevealCard. */}
          <div className="landing-grid landing-grid-secondary forced-dark">
            {SECONDARY_FEATURES.map((feature, i) => (
              <RevealCard
                key={feature.title}
                className="landing-card card-hover"
                accent={feature.accent}
                delay={Math.min(i * 50, 200)}
              >
                <FeatureIcon path={feature.icon} />
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </RevealCard>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="landing-section landing-section-alt">
          <Reveal variant="up">
            <h2>How it works</h2>
            <p className="landing-section-sub">Three steps from upload to answers.</p>
          </Reveal>
          {/* The section's one illustration. It shows what the three step cards
              below describe: a document, sliced into embedded chunks, answered
              from. Inline SVG, aria-hidden, themed from currentColor — see
              FlowIllustration. */}
          <Reveal variant="up">
            <FlowIllustration />
          </Reveal>
          <div className="landing-steps forced-dark">
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
            <p className="landing-section-sub">Start free, upgrade when your team needs more.</p>
          </Reveal>

          <Reveal variant="up" delay={80}>
            <BillingToggle annual={annual} onChange={setAnnual} />
          </Reveal>

          <div className="landing-plans forced-dark">
            {PLANS.map((plan, i) => (
              <Reveal key={plan.name} variant="up" delay={Math.min(i * 80, 160)}>
                <article
                  className={`landing-plan card-hover${plan.featured ? " landing-plan-featured" : ""}`}
                >
                  {plan.featured && <span className="plan-badge">Most Popular</span>}
                  <h3>{plan.name}</h3>
                  <PlanPrice price={annual ? plan.annual : plan.monthly} period={plan.period} />
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
            <PlanComparison />
          </Reveal>
        </section>

        <section id="faq" className="landing-section landing-section-alt">
          <Reveal variant="up">
            <h2>Frequently asked questions</h2>
            <p className="landing-section-sub">Everything else — just ask us.</p>
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
            <p className="landing-cta-band-sub">
              Upload a file and ask a question in under a minute. No credit card, no setup — your
              first three documents are free.
            </p>
            <div className="landing-ctas">
              <Link to="/demo" className="btn btn-primary btn-lg">
                Try the live demo
              </Link>
              {secondaryCta}
            </div>
          </Reveal>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}
