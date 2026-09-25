import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../hooks/useAuth";

/** Marketing navigation shown on the public landing page. When the visitor is
 *  already signed in the auth button becomes a shortcut back to the app
 *  instead of a sign-up prompt. */
export function LandingNavbar() {
  const { user } = useAuth();

  return (
    <nav className="landing-navbar">
      <Link to="/" className="landing-brand" aria-label="AskDocs home">
        <svg
          className="landing-brand-mark"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M6 3h8l4 4v14H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M14 3v4h4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 12l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9.9-1.9Z"
            fill="currentColor"
          />
        </svg>
        AskDocs
      </Link>

      <div className="landing-nav-links">
        <a href="/#features">Features</a>
        <a href="/#how-it-works">How it works</a>
        <a href="/#pricing">Pricing</a>
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