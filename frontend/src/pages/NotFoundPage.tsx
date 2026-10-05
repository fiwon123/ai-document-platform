import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="page not-found-page">
      <div className="not-found-code gradient-text" aria-hidden="true">
        404
      </div>
      <h1 className="not-found-title">Page not found</h1>
      <p className="not-found-copy">This page could not be found.</p>
      <p className="not-found-detail">
        The page you are looking for might have been moved or never existed.
      </p>
      <div className="not-found-actions">
        <Link to="/app" className="btn btn-primary">
          Back to dashboard
        </Link>
        <Link to="/" className="btn btn-secondary">
          Go home
        </Link>
      </div>
    </div>
  );
}