import { useEffect, useState } from "react";
import { statistics } from "../services/api";
import type { DocumentStatus, StatisticsResponse } from "../types";

const STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

export function DashboardPage() {
  const [stats, setStats] = useState<StatisticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    statistics
      .getMe()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  if (error) {
    return (
      <div className="page">
        <p className="error-message">{error}</p>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const statusCards = (
    [
      ["ready", stats.ready_documents],
      ["pending", stats.pending_documents],
      ["processing", stats.processing_documents],
      ["failed", stats.failed_documents],
    ] as const
  ).map(([status, count]) => ({
    status,
    label: STATUS_LABELS[status],
    count,
  }));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p>Overview of your documents</p>
      </header>

      <div className="stats-grid">
        <div className="stat-card stat-total">
          <span className="stat-value">{stats.total_documents}</span>
          <span className="stat-label">Documents</span>
        </div>
        {statusCards.map((card) => (
          <div key={card.status} className={`stat-card stat-${card.status}`}>
            <span className="stat-value">{card.count}</span>
            <span className="stat-label">{card.label}</span>
          </div>
        ))}
        <div className="stat-card stat-chunks">
          <span className="stat-value">{stats.total_chunks}</span>
          <span className="stat-label">Chunks indexed</span>
        </div>
      </div>

      <section className="recent-section">
        <h2>Recently uploaded</h2>
        {stats.recent_documents.length === 0 ? (
          <div className="empty-state">
            <p>No documents yet. Upload your first document to get started.</p>
          </div>
        ) : (
          <ul className="recent-list">
            {stats.recent_documents.map((doc) => (
              <li key={doc.id} className="recent-item">
                <span className="recent-filename">{doc.filename}</span>
                <span className="status-badge">{STATUS_LABELS[doc.status]}</span>
                <span className="recent-date">
                  {new Date(doc.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}