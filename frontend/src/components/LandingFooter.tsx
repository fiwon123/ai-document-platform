import { Link } from "react-router-dom";
import { NAV_COMPANY, NAV_LEGAL, NAV_PRODUCT, SITE, SOCIAL_PATHS } from "../content/marketing";

/**
 * A social icon.
 *
 * Accounts we don't actually run render as a dead block rather than a link:
 * `comingSoon` drops the href behaviour, dims the icon, and disables the hover
 * lift. Twitter and LinkedIn are deliberately in this state — shipping an icon
 * that 404s or points at somebody else's profile is worse than showing
 * "not yet".
 */
function SocialLink({
  label,
  path,
  href,
  title,
  comingSoon = false,
}: {
  label: string;
  path: string;
  href?: string;
  title?: string;
  /** Placeholder for accounts we don't run yet — dimmed, not a link. */
  comingSoon?: boolean;
}) {
  if (comingSoon) {
    // Rendered as a <span>, not an <a>: a link with no real destination is
    // still focusable, still announced as a link, and still in the tab order
    // for no benefit. A span with role="img" conveys "this is the Twitter
    // icon, it isn't going anywhere" without pretending to be actionable.
    return (
      <span
        className="footer-social coming-soon"
        role="img"
        aria-label={`${label} (coming soon)`}
        title={title}
        data-coming-soon="true"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d={path} fill="currentColor" />
        </svg>
      </span>
    );
  }

  return (
    <a
      className="footer-social"
      href={href}
      aria-label={label}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path d={path} fill="currentColor" />
      </svg>
    </a>
  );
}

/** The footer lists each section's hub first, then its pages. A column headed
 *  "Product" whose only links lead to sub-pages leaves no way to reach the
 *  section overview the header already offers. */
const FOOTER_COLUMNS = [
  { label: "Product", hub: "/product", items: NAV_PRODUCT },
  { label: "Company", hub: "/company", items: NAV_COMPANY },
  { label: "Legal", hub: null, items: NAV_LEGAL },
] as const;

export function LandingFooter() {
  const handleNewsletter = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("email") as HTMLInputElement;
    if (input?.value) {
      input.value = "";
    }
  };

  return (
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
          <span className="footer-brand-name">{SITE.name}</span>
          <p>{SITE.tagline}</p>
          <div className="footer-socials">
            <SocialLink
              label={`${SITE.name} on GitHub`}
              path={SOCIAL_PATHS.github}
              href={SITE.repoUrl}
              title="View source on GitHub"
            />
            <SocialLink
              label={`${SITE.name} on Twitter`}
              path={SOCIAL_PATHS.twitter}
              title="Coming soon"
              comingSoon
            />
            <SocialLink
              label={`${SITE.name} on LinkedIn`}
              path={SOCIAL_PATHS.linkedin}
              title="Coming soon"
              comingSoon
            />
          </div>
        </div>
        {FOOTER_COLUMNS.map((col) => (
          <nav key={col.label} className="footer-col" aria-label={col.label}>
            <strong>{col.label}</strong>
            {col.hub && (
              <Link to={col.hub} className="footer-col-hub">
                Overview
              </Link>
            )}
            {col.items.map((item) => (
              <Link key={item.to} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
        ))}
      </div>

      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} {SITE.name}</span>
        <span>Made for people who love their documents.</span>
      </div>
    </footer>
  );
}
