import { EmptyState } from "../components/EmptyState";

export function NotFoundPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>404</h1>
        <p>This page could not be found.</p>
      </header>
      <EmptyState
        title="Page not found"
        description="The page you are looking for might have been moved or never existed."
        action={{ label: "Back to dashboard", to: "/app" }}
      />
    </div>
  );
}