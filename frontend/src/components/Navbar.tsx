import { memo, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ThemeToggle } from "./ThemeToggle";

interface NavLinkDef {
  to: string;
  label: string;
  /** True when the current pathname should mark this link active. */
  isActive: (pathname: string) => boolean;
  adminOnly?: boolean;
}

const NAV_LINKS: NavLinkDef[] = [
  {
    to: "/",
    label: "Home",
    isActive: (pathname) => pathname === "/",
  },
  {
    to: "/app",
    label: "Dashboard",
    isActive: (pathname) => pathname === "/app" || pathname === "/app/",
  },
  {
    to: "/app/documents",
    label: "Documents",
    isActive: (pathname) => pathname.startsWith("/app/documents"),
  },
  {
    to: "/app/search",
    label: "Search",
    isActive: (pathname) => pathname.startsWith("/app/search"),
  },
  {
    to: "/app/qa",
    label: "Q&A",
    isActive: (pathname) => pathname.startsWith("/app/qa"),
  },
  {
    to: "/app/settings",
    label: "Settings",
    isActive: (pathname) => pathname.startsWith("/app/settings"),
  },
  {
    to: "/app/webhooks",
    label: "Webhooks",
    isActive: (pathname) => pathname.startsWith("/app/webhooks"),
  },
  { to: "/app/admin", label: "Users", isActive: (p) => p.startsWith("/app/admin"), adminOnly: true },
];

/**
 * Memoized app navbar: it takes no props, so parent re-renders (page state)
 * are skipped; only the auth/theme contexts it consumes and route changes
 * (needed for the active link state) trigger a re-render.
 */
export const Navbar = memo(function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = () => setMenuOpen(false);

  const handleLogout = () => {
    closeMenu();
    logout();
    navigate("/login");
  };

  // Mobile menu key handling (ARIA disclosure pattern, APG "Navigation Menu
  // Button"): focus moves to the first link when the menu opens, and Escape
  // closes it and returns focus to the toggle. Tab follows the natural DOM
  // order — a disclosure menu is not a modal dialog, so it must not trap
  // focus (trapping would strand keyboard users from the toggle).
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>("a[href], button:not([disabled])")
      ?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <nav className="navbar">
      <div className="navbar-brand">
<Link to="/app" aria-label="AskDocs home" onClick={closeMenu}>
          AskDocs
        </Link>
      </div>

      <button
        ref={toggleRef}
        type="button"
        className="navbar-toggle"
        aria-expanded={menuOpen}
        aria-controls="navbar-links"
        aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="navbar-toggle-bar" />
        <span className="navbar-toggle-bar" />
        <span className="navbar-toggle-bar" />
      </button>

      <div
        ref={menuRef}
        className={`navbar-links${menuOpen ? " navbar-links-open" : ""}`}
        id="navbar-links"
      >
        {NAV_LINKS.filter((link) => !link.adminOnly || user?.role === "admin").map(
          (link) => {
            const active = link.isActive(pathname);
            return (
              <Link
                key={link.to}
                to={link.to}
                onClick={closeMenu}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          },
        )}
        {user && (
          <div className="navbar-user-mobile">
            <Link to="/app/profile" onClick={closeMenu}>
              {user.username}
            </Link>
            <ThemeToggle />
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          </div>
        )}
      </div>

      <div className="navbar-user">
        <ThemeToggle />
        {user && (
          <>
            <Link to="/app/profile" className="navbar-username">
              {user.username}
            </Link>
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          </>
        )}
      </div>
    </nav>
  );
});