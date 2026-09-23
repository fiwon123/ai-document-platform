import { memo, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";

/**
 * Memoized app navbar: it takes no props, so parent re-renders (route
 * changes, page state) are skipped entirely; only the auth/theme contexts
 * it consumes can trigger a re-render.
 */
export const Navbar = memo(function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
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
        <Link to="/app" onClick={closeMenu}>
          Dashboard
        </Link>
        <Link to="/app/documents" onClick={closeMenu}>
          Documents
        </Link>
        <Link to="/app/search" onClick={closeMenu}>
          Search
        </Link>
        <Link to="/app/qa" onClick={closeMenu}>
          Q&A
        </Link>
        <Link to="/app/settings" onClick={closeMenu}>
          Settings
        </Link>
        <Link to="/app/webhooks" onClick={closeMenu}>
          Webhooks
        </Link>
        {user?.role === "admin" && (
          <Link to="/app/admin" onClick={closeMenu}>
            Users
          </Link>
        )}
        {user && (
          <div className="navbar-user-mobile">
            <Link to="/app/profile" onClick={closeMenu}>
              {user.username}
            </Link>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          </div>
        )}
      </div>

      <div className="navbar-user">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
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