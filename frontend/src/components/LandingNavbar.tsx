import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../hooks/useAuth";
import { BrandMark } from "./icons";
import { NAV_COMPANY, NAV_PRODUCT } from "../content/marketing";

/** The Product and Company hubs. `/company` is `NAV_COMPANY`'s own first entry
 *  rather than a separate constant, so the header, the footer column and the
 *  hub page cannot disagree about what the section is called (#584). */
const PRODUCT_HUB = "/product";
const COMPANY_HUB = "/company";

/**
 * Marketing navigation shown on every public page. When the visitor is already
 * signed in the auth button becomes a shortcut back to the app instead of a
 * sign-up prompt.
 *
 * Product is a flat list rather than a menu. Its five destinations are the
 * header's primary content, and hiding them behind a disclosure meant the one
 * section a visitor is most likely to want cost a hover, a click, and two tab
 * stops to reach.
 *
 * Company is the header's one disclosure. Its five leaf pages are a section a
 * visitor descends into rather than a destination in their own right, so the
 * trigger opens a small menu — on hover for a pointer, on click/Enter for
 * touch and keyboard — with the hub itself as its first item. `NAV_COMPANY`
 * still defines the section, so the trigger's active state, the menu items and
 * the footer column are all derived from the same list and cannot drift.
 *
 * Legal pages are deliberately absent: they live in the footer only. Putting
 * eight destinations in the header turns navigation into a wall of links, and
 * nobody reaches a GDPR page from a primary nav.
 *
 * ## Mobile (#557)
 *
 * Below the collapse width the flat list used to move to its own full-width row
 * and wrap: at 375px it needed three rendered lines and the header measured
 * **241px, 30% of an 812px viewport**, before any page content. The links had
 * nowhere to go — six destinations plus a brand, a toggle and two buttons do
 * not fit on one 330px line — so they spilled rather than collapsing.
 *
 * They now collapse into a disclosure panel, the same pattern the workspace
 * `Navbar` already uses. Both navbars being hamburger-driven at the same
 * breakpoint is deliberate: a header that is a wall of links on desktop and a
 * menu on mobile is a normal, recognisable pattern, and reusing the workspace
 * navbar's keyboard handling keeps one implementation to reason about.
 *
 * The panel carries the thing the row cannot afford at this width: the theme
 * toggle. The **primary CTA stays in the row**, which is why the toggle is what
 * moved — see the width arithmetic on the toggle rules in `App.css`.
 *
 * The demo CTA is *not* duplicated into the panel. `NAV_PRODUCT` already
 * contributes a "Live demo" link to `/demo` to the list the panel shows, so a
 * second control would put the same destination twice in one menu. On desktop
 * the row's own "Try the demo" button is dropped below 1200px and that link is
 * what remains — which is this issue's "present or deliberately replaced with an
 * equivalent", satisfied by an equivalent rather than by a second button.
 */
export function LandingNavbar() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  /* Openness is tracked as the path the panel was opened *for*. A plain boolean
     needs an effect to close on navigation, and a setState-in-effect is a
     second render pass for something the render already knows: the panel was
     opened on one route, the route changed, so it is closed. It also means a
     browser back/forward cannot leave the panel hanging open over unrelated
     content. */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const menuOpen = openedFor === pathname;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setOpenedFor(null), []);

  /* One link now stands for the whole section, so the active state has to cover
     the section rather than just the page: on `/about` the Company link is where
     you came from, and marking nothing active would lose that. Derived from
     `NAV_COMPANY` rather than a second hardcoded route list, so adding a company
     page cannot leave the header blind to it — the same single-source rule the
     footer column follows (#584). */
  const companyActive = NAV_COMPANY.some((item) => pathname === item.to);
  const companyItems = NAV_COMPANY.filter((item) => item.to !== "/company");
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const companyDropdownRef = useRef<HTMLDivElement>(null);

  /* Open on hover only where the pointer can actually hover. On a touch device
     a tap fires `mouseenter` immediately before `click`, so an unguarded
     `onMouseEnter` opened the menu and the following `click` toggled it straight
     back shut — the submenu never appeared on the first tap. `(hover: none)`
     devices skip the JS hover entirely and let `click` own the toggle; desktop
     keeps hover-to-open. Guarded because jsdom may not implement `matchMedia`. */
  const hoverOpensMenu = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

  // Mobile panel key handling (ARIA disclosure, APG "Navigation Menu Button"):
  // focus moves to the first link on open, Escape closes and returns focus to
  // the toggle. Tab follows DOM order — a disclosure panel is not a dialog, so
  // it must NOT trap focus or a keyboard user could never leave it.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenu();
      setCompanyMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, closeMenu]);

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (
        companyDropdownRef.current &&
        !companyDropdownRef.current.contains(event.target as Node)
      ) {
        setCompanyMenuOpen(false);
      }
    };
    if (companyMenuOpen) {
      document.addEventListener("mousedown", onClickOutside);
    }
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [companyMenuOpen]);

  // Escape closes the Company menu wherever focus sits inside it. The mobile
  // panel's own Escape handler above only runs while that panel is open, so
  // without this the desktop menu had no keyboard way out.
  useEffect(() => {
    if (!companyMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCompanyMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [companyMenuOpen]);

  const toggleMenu = useCallback(() => {
    setOpenedFor((current) => (current === pathname ? null : pathname));
    setCompanyMenuOpen(false);
  }, [pathname]);

  return (
    <nav className="landing-navbar">
      <Link to="/" className="landing-brand" aria-label="AskDocs home">
        <BrandMark className="landing-brand-mark" />
        AskDocs
      </Link>

      <div
        ref={menuRef}
        id="landing-nav-links"
        className={`landing-nav-links${menuOpen ? " landing-nav-links-open" : ""}`}
      >
        {/* The hub is composed here rather than added to NAV_PRODUCT: the footer
            derives its own Overview link from the column's `hub` field, so
            putting it in the shared array would render it twice down there. */}
        <div className="nav-flat">
          <Link
            to={PRODUCT_HUB}
            onClick={closeMenu}
            className={pathname === PRODUCT_HUB ? "active" : undefined}
            aria-current={pathname === PRODUCT_HUB ? "page" : undefined}
          >
            Overview
          </Link>
          {NAV_PRODUCT.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={closeMenu}
              className={pathname === item.to ? "active" : undefined}
              aria-current={pathname === item.to ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
          {/* Company is the header's one disclosure: the section has five
              leaf pages, which is more than the row can carry as flat links.
              The trigger reads as active across the whole section, and the menu
              leads with the hub itself so "the section overview" stays one
              click away. */}
          <div
            className="nav-group nav-group--company"
            ref={companyDropdownRef}
            onMouseEnter={() => {
              if (hoverOpensMenu()) setCompanyMenuOpen(true);
            }}
            onMouseLeave={() => {
              if (hoverOpensMenu()) setCompanyMenuOpen(false);
            }}
          >
            <button
              type="button"
              className={`nav-group-trigger${companyActive ? " active" : ""}`}
              aria-expanded={companyMenuOpen}
              aria-controls="company-nav-menu"
              onClick={() => setCompanyMenuOpen((current) => !current)}
            >
              Company
              <svg
                className="nav-group-chevron"
                viewBox="0 0 24 24"
                width="16"
                height="16"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M6 9l6 6 6-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div
              id="company-nav-menu"
              className={`nav-group-menu forced-dark${companyMenuOpen ? " open" : ""}`}
              role="menu"
            >
              <Link
                to={COMPANY_HUB}
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  setCompanyMenuOpen(false);
                }}
                className={pathname === COMPANY_HUB ? "active" : undefined}
                aria-current={pathname === COMPANY_HUB ? "page" : undefined}
              >
                General
              </Link>
              {companyItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setCompanyMenuOpen(false);
                  }}
                  className={pathname === item.to ? "active" : undefined}
                  aria-current={pathname === item.to ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Only rendered in the collapsed band, because the row's copy of the
            theme toggle is hidden here. There is deliberately no "Try the demo"
            button in the panel — see the note on the component above. */}
        <div className="landing-nav-panel-actions">
          <ThemeToggle />
        </div>
      </div>

      {/* Actions come after the links so the row reads brand | links | actions,
          with the link group centred between the two clusters by
          `margin-inline: auto`. In DOM order before them they sat hard against
          the brand and pushed the links to the right gutter: the toggle and the
          two buttons read as the header's leading content and the navigation
          read as a trailing afterthought. Source order is what assistive tech
          and Tab follow, so this is also the reading order. */}
      <div className="landing-nav-actions">
        {/* Desktop placement. At the collapse width the row cannot hold both
            this and the CTA (see App.css), so the panel carries a copy — the
            same mutually-exclusive pair the workspace navbar uses for its
            `.navbar-user` / `.navbar-user-mobile` cluster. Exactly one is ever
            displayed, so only one reaches the accessibility tree. */}
        <ThemeToggle />
        <Link to="/demo" className="btn btn-secondary">
          Try the demo
        </Link>
        {user ? (
          <Link to="/app" className="btn btn-primary">
            Go to app
          </Link>
        ) : (
          <Link to="/login" className="btn btn-primary">
            Sign up
          </Link>
        )}
        <button
          ref={toggleRef}
          type="button"
          className="landing-nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="landing-nav-links"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          onClick={toggleMenu}
        >
          <span className="landing-nav-toggle-bar" />
          <span className="landing-nav-toggle-bar" />
          <span className="landing-nav-toggle-bar" />
        </button>
      </div>
    </nav>
  );
}
