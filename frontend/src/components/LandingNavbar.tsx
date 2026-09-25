import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../hooks/useAuth";
import { BrandMark } from "./icons";
import { NAV_COMPANY, NAV_PRODUCT } from "../content/marketing";

/**
 * Header section menu.
 *
 * Built on the disclosure pattern rather than the ARIA `menu` pattern: a button
 * carrying `aria-expanded` reveals a set of ordinary links. ARIA menus oblige
 * the author to implement arrow-key roving focus, Home/End, and type-ahead, and
 * a half-implemented menu widget is worse for keyboard and screen-reader users
 * than a plain list of links. The disclosure gives the same result with the
 * links behaving like links.
 */
function NavGroupMenu({
  label,
  hub,
  items,
}: {
  label: string;
  /** The section hub — also the first item inside the menu. */
  hub: string;
  items: { label: string; to: string }[];
}) {
  /* Openness is derived from which path the menu was opened *for* rather than
     stored as a boolean. A plain boolean needs an effect to close on
     navigation, and a setState-in-effect is a second render pass for something
     the render already knows: if the menu was opened for a different path, the
     user has moved on, so it is closed. */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const { pathname } = useLocation();

  const open = openedFor === pathname;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setOpenedFor(null);
  }, [cancelClose]);

  const openNow = useCallback(() => setOpenedFor(pathname), [pathname]);

  const toggle = useCallback(
    () =>
      setOpenedFor((current) => (current === pathname ? null : pathname)),
    [pathname],
  );

  useEffect(() => cancelClose, [cancelClose]);

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

  /**
   * Hover intent.
   *
   * The menu is offset 10px below the trigger so it reads as a separate surface
   * rather than a continuation of the button. That offset creates a band of
   * empty space between them, and because an absolutely positioned child does
   * not contribute to its parent's hover box, the pointer is *outside* the
   * container while crossing it. Closing on `mouseleave` therefore dismissed the
   * menu before the pointer could arrive — the original bug.
   *
   * Two things fix it together:
   *   1. A short grace period on the way out, so a diagonal path across the gap
   *      is not treated as leaving.
   *   2. An explicit hover bridge — a transparent strip owned by the container
   *      that covers the gap, so the pointer is technically still inside.
   *
   * Only `(hover: hover)` devices opt in. A touch device has no hover, and
   * `mouseleave` there would fire on tap, making the menu undismissable.
   */
  const hoverable =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

  const scheduleClose = () => {
    if (!hoverable) return;
    cancelClose();
    closeTimer.current = setTimeout(close, 140);
  };

  // The hub counts as active too, otherwise visiting a child page leaves the
  // trigger looking unselected.
  const active =
    pathname === hub || items.some((item) => pathname === item.to);

  return (
    <div
      className="nav-group"
      ref={containerRef}
      onMouseEnter={() => {
        if (!hoverable) return;
        cancelClose();
        openNow();
      }}
      onMouseLeave={scheduleClose}
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
        {label}
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
        <div
          className="nav-group-menu"
          id={menuId}
          // Entering the menu cancels the pending close. Without this the
          // 140ms grace period would close the menu out from under a pointer
          // that made it across the gap but then paused inside.
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <Link to={hub} className="nav-group-overview">
            {label} overview
          </Link>
          {items.map((item) => (
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

/** Section hubs — also the first item inside each menu. */
const PRODUCT_HUB = "/product";
const COMPANY_HUB = "/company";

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
        <NavGroupMenu label="Product" hub={PRODUCT_HUB} items={NAV_PRODUCT} />
        <NavGroupMenu label="Company" hub={COMPANY_HUB} items={NAV_COMPANY} />
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
