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
     user has moved on, so it is closed.

     Alongside the path it records *how* the menu was opened, because hover and
     click mean opposite things here (#591). One object rather than two pieces of
     state, so the two cannot disagree: `pinned` is only ever read together with
     the path it was pinned for. */
  const [state, setState] = useState<{ path: string; pinned: boolean } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const { pathname } = useLocation();

  const open = state?.path === pathname;
  const pinned = open && state?.pinned === true;

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setState(null);
  }, [cancelClose]);

  /* Hover opens it *unpinned*: the menu is on loan to the pointer and is
     dismissed when the pointer leaves. It never clears an existing pin, so
     arriving at a pinned menu does not un-pin it. */
  const openNow = useCallback(
    () =>
      setState((current) =>
        current?.path === pathname && current.pinned
          ? current
          : { path: pathname, pinned: false },
      ),
    [pathname],
  );

  /* Click is not the negation of hover (#591). Every pointer interaction begins
     with a move onto the element, so for a mouse the click always arrives after
     hover has already opened the menu — a plain toggle therefore closed what the
     pointer had just opened and the click did nothing observable at all. Worse,
     it inverted: the first click closed, and only the second one opened.

     So a click *pins*: hovering in, clicking keeps it open; clicking a pinned
     menu closes it. A click is never a no-op, and never means the opposite of
     what the previous one did. On touch, where `hoverable` is false and nothing
     ever opens by hover, this is an ordinary toggle. */
  const toggle = useCallback(
    () =>
      setState((current) =>
        current?.path === pathname && current.pinned
          ? null
          : { path: pathname, pinned: true },
      ),
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
   *
   * Hover is also *transitional*: the menu is on loan to the pointer, and only a
   * click pins it so the pointer can leave it open (#591). See `toggle`.
   */
  const hoverable =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches;

  const scheduleClose = () => {
    // `pinned` first: a menu the user opened by clicking stays open when the
    // pointer leaves. Escape, an outside click and navigation all still dismiss
    // it, so pinning is not a trap — it is what makes the click meaningful.
    if (!hoverable || pinned) return;
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

/** Section hubs. The Product hub is a flat list in the desktop row; Company is a
 *  disclosure, and is a flat list again inside the mobile panel — see below. */
const PRODUCT_HUB = "/product";
const COMPANY_HUB = "/company";

/**
 * Marketing navigation shown on every public page. When the visitor is already
 * signed in the auth button becomes a shortcut back to the app instead of a
 * sign-up prompt.
 *
 * Product is a flat list rather than a second menu. Its five destinations are
 * the header's primary content, and hiding them behind a disclosure meant the
 * one section a visitor is most likely to want cost a hover, a click, and two
 * tab stops to reach. Company stays a menu: it is a section rather than a set
 * of pages someone arrives on directly, and leaving it alone keeps the header
 * from flattening into a wall of links.
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
  /* Openness is tracked as the path the panel was opened *for*, the same trick
     NavGroupMenu below uses. A plain boolean needs an effect to close on
     navigation, and a setState-in-effect is a second render pass for something
     the render already knows: the panel was opened on one route, the route
     changed, so it is closed. It also means a browser back/forward cannot
     leave the panel hanging open over unrelated content. */
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const menuOpen = openedFor === pathname;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setOpenedFor(null), []);

  // Mobile panel key handling (ARIA disclosure, APG "Navigation Menu Button"):
  // focus moves to the first link on open, Escape closes and returns focus to
  // the toggle. Tab follows DOM order — a disclosure panel is not a dialog, so
  // it must NOT trap focus or a keyboard user could never leave it.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>("a[href], button:not([disabled])")
      ?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenu();
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, closeMenu]);

  const toggleMenu = useCallback(
    () => setOpenedFor((current) => (current === pathname ? null : pathname)),
    [pathname],
  );

  return (
    <nav className="landing-navbar">
      <Link to="/" className="landing-brand" aria-label="AskDocs home">
        <BrandMark className="landing-brand-mark" />
        AskDocs
      </Link>

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
        </div>

        <NavGroupMenu label="Company" hub={COMPANY_HUB} items={NAV_COMPANY} />

        {/* Only rendered in the collapsed band, because the row's copy of the
            theme toggle is hidden here. There is deliberately no "Try the demo"
            button in the panel — see the note on the component above. */}
        <div className="landing-nav-panel-actions">
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
