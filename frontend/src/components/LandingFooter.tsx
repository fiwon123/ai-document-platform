import { useState } from "react";
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
  viewBox = "0 0 24 24",
  comingSoon = false,
}: {
  label: string;
  path: string;
  href?: string;
  title?: string;
  /**
   * Per-icon viewBox, matching the grid the path was authored on.
   *
   * This exists because the glyphs are NOT all on one grid: GitHub is a 16x16
   * Octicons mark, the rest are 24x24. Rendering all three at `width={18}` with
   * a hardcoded `0 0 24 24` viewBox silently scales the 16-unit GitHub disc down
   * to 12px, so it looks smaller than its neighbours. A viewBox is a scale, not
   * a stretch: it cannot make a non-square glyph square, and it cannot change a
   * silhouette's shape. Both of those needed a different path (see SOCIAL_PATHS).
   */
  viewBox?: string;
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
        <svg viewBox={viewBox} width="18" height="18" aria-hidden="true" focusable="false">
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
      <svg viewBox={viewBox} width="18" height="18" aria-hidden="true" focusable="false">
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

/** What the form reports back to the visitor. One region, one message at a time:
 *  a second submit replaces the text rather than appending, so the element stays
 *  a single live region instead of a growing log. */
type NewsletterStatus = { kind: "ok" | "error"; message: string } | null;

/** No mailing list is connected to this form yet, so it must not say one is.
 *  Both of these are asserted by the tests: the promise and the confirmation are
 *  the two places a stub form could quietly lie to a visitor, and a test that
 *  pins the exact string makes rewording either of them a deliberate edit. */
const SUBSCRIBED_NOTE =
  "Thanks for trying — no mailing list is connected yet, so this didn't sign you up.";
const NOT_A_VALID_ADDRESS = "Enter a valid email address.";

export function LandingFooter() {
  const [status, setStatus] = useState<NewsletterStatus>(null);

  const handleNewsletter = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("email") as HTMLInputElement | null;

    // The browser's own constraints are the only validation there is. A second
    // rule of my own would be weaker than `type="email"` and would disagree with
    // the bubble the visitor has just dismissed.
    if (!input?.checkValidity()) {
      setStatus({ kind: "error", message: NOT_A_VALID_ADDRESS });
      // Focus follows the error: the message is announced, but a keyboard user
      // who submitted with the mouse has no other way back to the field.
      input?.focus();
      return;
    }

    // The field is cleared because the address *looked* right, not because
    // anything was stored — so the message has to say so, or clearing the field
    // reads as a subscription that happened.
    setStatus({ kind: "ok", message: SUBSCRIBED_NOTE });
    if (input) {
      input.value = "";
    }
  };

  return (
    <footer className="landing-footer">
      <div className="footer-cols">
        <div className="footer-col footer-brand">
          <span className="footer-brand-name">{SITE.name}</span>
          <p>{SITE.tagline}</p>
          <div className="footer-socials">
            {/* GitHub's path is authored on a 16x16 grid (the Octicons mark),
                so it needs a 16x16 viewBox. Without this the disc renders at
                16/24 of 18px — two-thirds the size of its neighbours, which
                reads as "the GitHub button is smaller" rather than "the GitHub
                glyph is a circle". */}
            <SocialLink
              label={`${SITE.name} on GitHub`}
              path={SOCIAL_PATHS.github}
              href={SITE.repoUrl}
              title="View source on GitHub"
              viewBox="0 0 16 16"
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

          {/* The subscribe form lives in the brand column, under the social
              icons, rather than in a full-width band of its own.

              As a sibling of the columns it read as a footer headline: an
              optional signup given a hairline and a row to itself, louder than
              the navigation it outranked. The brand column is the widest (2fr)
              and had empty space beneath the icons while the adjacent nav
              columns ran taller, so the form fills that space instead of
              claiming a new one.

              Order inside the column is deliberate — who this is, where else to
              go, then the optional follow-up — and each part is its own block,
              so the invitation never competes with the links above it. The form
              row stays a single flex row: the input and button must share a
              line so their heights match (see the alignment fix in #402). */}
          {/* `noValidate` is load-bearing, and the unit tests cannot catch its
              absence: `type="email"` makes the browser block the submit event
              itself when the address is malformed, so the handler below never
              runs and the error message never appears in a real browser — the
              tests still pass, because jsdom dispatches `submit` directly and
              skips interactive validation. Owning the check here means
              `checkValidity()` stays the single source of truth (the browser's
              own rules, not a second weaker set) while the message, the
              `aria-invalid` flip, and the focus move actually reach the user. */}
          <form className="newsletter" onSubmit={handleNewsletter} noValidate>
            <div className="newsletter-copy">
              <strong>Stay in the loop</strong>
              {/* No promise of a monthly email, because there is no list to send
                  one from. The previous copy ("Product updates, once a month. No
                  spam.") described a mailing list that does not exist, and the
                  form underneath it silently cleared whatever was typed. */}
              <span>A preview of the signup — no mailing list is connected yet.</span>
            </div>
            <div className="newsletter-form">
              <input
                id="newsletter-email"
                type="email"
                name="email"
                required
                placeholder="you@company.com"
                aria-label="Email address"
                aria-invalid={status?.kind === "error"}
                autoComplete="email"
              />
              <button type="submit" className="btn btn-primary">
                Subscribe
              </button>
            </div>
            {/* Rendered unconditionally, filled in on submit. A region that
                arrives with its own text is the classic silent live region. */}
            <p
              className="newsletter-status"
              role="status"
              aria-live="polite"
              data-kind={status?.kind ?? "none"}
            >
              {status?.message ?? ""}
            </p>
          </form>
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
