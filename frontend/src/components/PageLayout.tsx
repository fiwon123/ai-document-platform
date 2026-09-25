import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LandingNavbar } from "./LandingNavbar";
import { LandingFooter } from "./LandingFooter";

/**
 * Shared shell for every marketing page.
 *
 * The point is that a new page cannot forget the navbar, the footer, or the
 * max-width container: it supplies a title, an optional subtitle, and its own
 * sections, and inherits the same chrome and measure as every other page. That
 * is why all 13 new routes look like one site instead of 13.
 *
 * `activePath` marks the current section in the header dropdowns. It is the
 * page's own path, so the highlight follows automatically as pages are added.
 */
export function PageLayout({
  title,
  subtitle,
  eyebrow,
  activePath,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Small label above the title, e.g. "Product". */
  eyebrow?: string;
  activePath?: string;
  children: ReactNode;
}) {
  return (
    <div className="landing-page marketing-page" data-active-path={activePath}>
      <LandingNavbar />

      <main className="page-main">
        <header className="page-hero">
          <div className="page-hero-inner">
            {eyebrow && <p className="landing-eyebrow">{eyebrow}</p>}
            <h1>{title}</h1>
            {subtitle && <p className="landing-sub">{subtitle}</p>}
          </div>
        </header>

        <div className="page-body">{children}</div>
      </main>

      <LandingFooter />
    </div>
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
}: {
  to: string;
  title: string;
  body: string;
  cta?: string;
}) {
  return (
    <Link to={to} className="page-card card-hover">
      <h2>{title}</h2>
      <p>{body}</p>
      <span className="page-card-cta">
        {cta} <span aria-hidden="true">→</span>
      </span>
    </Link>
  );
}

/**
 * A prose section with a heading.
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
    <section className="page-section">
      {title && <Heading className="page-section-title">{title}</Heading>}
      {children}
    </section>
  );
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
