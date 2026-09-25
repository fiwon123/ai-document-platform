import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../hooks/useAuth";
import { BrandMark } from "./icons";
import { NAV_COMPANY, NAV_PRODUCT } from "../content/marketing";

type NavGroup = {
  label: string;
  /** The section hub — also the first item inside the menu. */
  hub: string;
  items: { label: string; to: string }[];
};

/**
 * Header section menu.
 *
 * Built on the disclosure pattern rather than the ARIA `menu` pattern: a button
 * carrying `aria-expanded` reveals a set of ordinary links. ARIA menus oblige
 * the author to implement arrow-key roving focus, Home/End, and type-ahead, and
 * a half-implemented menu widget is worse for keyboard and screen-reader users
 * than a plain list of links. The disclosure gives the same result with the
 * links behaving like links.
 *
 * Opens on hover for pointer devices only (gated on `(hover: hover)` so touch
 * does not get a menu it cannot dismiss), and always on click, which is what
 * keyboard and touch users rely on.
 */
function NavGroupMenu({ group }: { group: NavGroup }) {
  /* Openness is derived from which path the menu was opened *for* rather than
     stored as a boolean. A plain boolean needs an effect to close on
     navigation, and a setState-in-effect is a second render pass for something
     the render already knows: if the menu was opened for a different path, the
     user has moved on, so it is closed. */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { pathname } = useLocation();

  const open = openedFor === pathname;
  const close = useCallback(() => setOpenedFor(null), []);
  const toggle = useCallback(
    () => setOpenedFor((current) => (current === pathname ? null : pathname)),
    [pathname],
  );

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      // Return focus to the trigger, otherwise Escape drops the user at the top
      // of the document with no indication where they were.
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // The hub counts as active too, otherwise visiting /pricing highlights
  // nothing until you are on one of the child pages.
  const active =
    pathname === group.hub ||
    group.items.some((item) => pathname === item.to);

  const hoverable = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

  return (
    <div
      className="nav-group"
      ref={containerRef}
      onMouseEnter={() => hoverable() && setOpenedFor(pathname)}
      onMouseLeave={() => hoverable() && close()}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`nav-group-trigger${active ? " active" : ""}`}
        aria-expanded={open}
        aria-controls={menuId}
        aria-current={active ? "true" : undefined}
        onClick={toggle}
      >
        {group.label}
        <svg
          className="nav-group-chevron"
          viewBox="0 0 24 24"
          width="14"
          height="14"
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

      {open && (
        <div className="nav-group-menu" id={menuId}>
          <Link to={group.hub} className="nav-group-overview">
            {group.label} overview
          </Link>
          {group.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={pathname === item.to ? "active" : undefined}
              aria-current={pathname === item.to ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const GROUPS: NavGroup[] = [
  { label: "Product", hub: "/product", items: NAV_PRODUCT },
  { label: "Company", hub: "/company", items: NAV_COMPANY },
];

/**
 * Marketing navigation shown on every public page. When the visitor is already
 * signed in the auth button becomes a shortcut back to the app instead of a
 * sign-up prompt.
 *
 * Legal pages are deliberately absent: they live in the footer only. Putting
 * eight destinations in the header turns navigation into a wall of links, and
 * nobody reaches a GDPR page from a primary nav.
 */
export function LandingNavbar() {
  const { user } = useAuth();

  return (
    <nav className="landing-navbar">
      <Link to="/" className="landing-brand" aria-label="AskDocs home">
        <BrandMark className="landing-brand-mark" />
        AskDocs
      </Link>

      <div className="landing-nav-links">
        {GROUPS.map((group) => (
          <NavGroupMenu key={group.label} group={group} />
        ))}
      </div>

      <div className="landing-nav-actions">
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
      </div>
    </nav>
  );
}
