import { Link } from "react-router-dom";

/** Marketing navigation shown on the public landing page (no auth needed). */
export function LandingNavbar() {
  return (
    <nav className="landing-navbar">
      <Link to="/" className="landing-brand" aria-label="AskDocs home">
        AskDocs
      </Link>

      <div className="landing-nav-links">
        <a href="/#features">Features</a>
        <a href="/#how-it-works">How it works</a>
        <a href="/#pricing">Pricing</a>
      </div>

      <div className="landing-nav-actions">
        <Link to="/demo" className="btn btn-secondary">
          Try the demo
        </Link>
        <Link to="/login" className="btn btn-primary">
          Sign up
        </Link>
      </div>
    </nav>
  );
}