import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "./LandingNavbar";
import { LandingFooter } from "./LandingFooter";
import { Reveal } from "./Reveal";

/**
 * The site chrome every public page renders inside: navbar, one `<main>` for
 * the page's own content, footer.
 *
 * Extracted from PageLayout so a page that does not want the hero treatment can
 * still get the same chrome by construction. That is what the public 404 does
 * (#461): it has its own layout, but it is still a public page, and when it
 * rendered bare — no navbar, no footer — a mistyped or stale URL was a dead end
 * with no route back to the marketing pages. Nothing here is optional per page,
 * so nothing here is a prop.
 *
 * The navbar and footer sit *outside* `<main>` on purpose: they are the banner
 * and contentinfo landmarks, page furniture rather than page content, and
 * burying them inside main is what makes a screen reader's landmark list
 * unreadable.
 */
export function MarketingShell({
  children,
  className,
}: {
  children: ReactNode;
  /** Extra class on the wrapper, e.g. PageLayout's "marketing-page". */
  className?: string;
}) {
  return (
    <div className={className ? `landing-page ${className}` : "landing-page"}>
      <LandingNavbar />

      <main className="page-main">{children}</main>

      <LandingFooter />
    </div>
  );
}

/**
 * Shared shell for every marketing page.
 *
 * The point is that a new page cannot forget the navbar, the footer, the hero
 * treatment, the entrance animation, or the max-width container: it supplies a
 * title, an optional subtitle, and its own sections, and inherits the same
 * chrome and measure as every other page. That is why all 13 routes look like
 * one site instead of 13.
 */
export function PageLayout({
  title,
  subtitle,
  eyebrow,
  children,
}: {
  title: ReactNode;
  subtitle?: string;
  /** Small label above the title, e.g. "Product". */
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <MarketingShell className="marketing-page">
      <header className="page-hero">
        {/* Reused verbatim from the landing hero so the two read as one site. */}
        <div className="hero-mesh" aria-hidden="true" />
        <div className="page-hero-inner">
          {eyebrow && (
            <Reveal variant="up">
              <p className="landing-eyebrow">{eyebrow}</p>
            </Reveal>
          )}
          <Reveal variant="up" delay={eyebrow ? 80 : 0}>
            <h1>{title}</h1>
          </Reveal>
          {subtitle && (
            <Reveal variant="up" delay={eyebrow ? 160 : 80}>
              <p className="landing-sub">{subtitle}</p>
            </Reveal>
          )}
        </div>
      </header>

      <div className="page-body">{children}</div>
    </MarketingShell>
  );
}

/**
 * A linked card used by the `/product` and `/company` hub pages.
 *
 * Deliberately an `<a>` styled as a card with a real `href` rather than a
 * button with an onClick: middle-click, ctrl-click, "copy link address" and
 * crawlers all work because it is a genuine link to a real route.
 */
export function PageCard({
  to,
  title,
  body,
  cta = "Read more",
  accent,
}: {
  to: string;
  title: string;
  body: string;
  cta?: string;
  /** One of the palette names; tints the card's leading edge on hover. */
  accent?: "blue" | "violet" | "green" | "amber" | "rose";
}) {
  return (
    <Link
      to={to}
      className="page-card card-hover"
      data-accent={accent}
    >
      <h2>{title}</h2>
      <p>{body}</p>
      <span className="page-card-cta">
        {cta} <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}

/**
 * A prose section with a heading, revealed as it scrolls into view.
 *
 * `level` lets a page keep a sensible heading outline — an h2 here, or an h3
 * when it sits under another heading — so pages don't jump from h1 straight to
 * h4 and break document navigation for screen reader users.
 */
export function PageSection({
  title,
  level = 2,
  children,
}: {
  title?: string;
  level?: 2 | 3;
  children: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <Reveal as="section" variant="up" className="page-section">
      {title && <Heading className="page-section-title">{title}</Heading>}
      {children}
    </Reveal>
  );
}

/**
 * Closing call to action for a marketing page.
 *
 * The landing page ends on a full-bleed animated gradient band. Interior pages
 * sit inside a max-width measure, so they get the contained equivalent — the
 * same blue→violet tint held in a bordered panel — rather than a band that no
 * longer reaches the viewport edge.
 *
 * Opt-in per page rather than automatic: a legal notice that ends with "Create
 * free account" is tone-deaf, and an empty blog index should not advertise
 * anything. Pages that sell something pass a `primary` action; pages that only
 * inform omit the component and end on their own content.
 */
export function PageCta({
  title,
  body,
  primary = { to: "/login", label: "Create free account" },
  secondary = { to: "/demo", label: "Try the live demo" },
}: {
  title: string;
  body: string;
  primary?: { to: string; label: string };
  secondary?: { to: string; label: string };
}) {
  return (
    <Reveal as="section" variant="up" className="page-cta-band">
      <h2>{title}</h2>
      <p className="page-cta-band-sub">{body}</p>
      <div className="page-cta-band-ctas">
        <Link to={primary.to} className="btn btn-primary btn-lg">
          {primary.label}
        </Link>
        <Link to={secondary.to} className="btn btn-secondary btn-lg">
          {secondary.label}
        </Link>
      </div>
    </Reveal>
  );
}

/**
 * Accent-tinted icon tile for a feature card.
 *
 * The tile is what turns a bare SVG into something that reads as a designed
 * element — it is the same 52px accent-tinted square the landing page's feature
 * cards use, so the two are visibly the same component.
 */
export function PageCardIcon({ children }: { children: ReactNode }) {
  return <span className="page-card-icon">{children}</span>;
}

/**
 * Banner marking a page as a starting template rather than final legal text.
 *
 * Present on every legal page on purpose: these read as real documents, and
 * publishing plausible-but-unreviewed policy text under a brand name is the
 * kind of thing that quietly becomes a real legal position. The notice is
 * visible in the page body, not hidden in a footer.
 */
export function TemplateNotice({ children }: { children: ReactNode }) {
  return (
    <aside className="template-notice" role="note">
      <strong>Template — review before publishing.</strong> {children}
    </aside>
  );
}
