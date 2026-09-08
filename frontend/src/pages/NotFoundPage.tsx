import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>404</h1>
        <p>This page could not be found.</p>
      </header>
      <div className="empty-state">
        <p>
          The page you are looking for might have been moved or never existed.
        </p>
        <Link to="/" className="btn btn-primary">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}