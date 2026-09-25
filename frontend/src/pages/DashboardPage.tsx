import { Link } from "react-router-dom";
import { useMyStatistics } from "../hooks/useStatistics";
import type { DocumentStatus } from "../types";
import { EmptyState } from "../components/EmptyState";
import { Badge, DOCUMENT_STATUS_TONE } from "../components/Badge";
import { Skeleton, SkeletonList } from "../components/Skeleton";

const STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

/* 16px Feather-style glyphs, hand-rolled (no icon library), aria-hidden
   because every icon accompanies visible text. Sizes inherit via CSS. */
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m12 2 10 6-10 6L2 8Z" />
      <path d="m2 14 10 6 10-6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

const QUICK_ACTIONS = [
  {
    to: "/app/documents",
    label: "Upload document",
    caption: "Add PDFs, text files and JSON",
    Icon: UploadIcon,
  },
  {
    to: "/app/search",
    label: "Search documents",
    caption: "Semantic search across your library",
    Icon: SearchIcon,
  },
  {
    to: "/app/qa",
    label: "Ask a question",
    caption: "Get AI answers grounded in your docs",
    Icon: ChatIcon,
  },
] as const;

const STATUS_ICONS: Record<DocumentStatus, () => React.JSX.Element> = {
  pending: ClockIcon,
  processing: RefreshIcon,
  ready: CheckCircleIcon,
  failed: AlertIcon,
};

export function DashboardPage() {
  const statsQuery = useMyStatistics();

  if (statsQuery.isPending) {
    return (
      <div className="page" role="status" aria-label="Loading dashboard">
        <header className="page-header">
          <h1>Dashboard</h1>
          <p>Overview of your documents</p>
        </header>
        <div className="stats-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="stat-card stat-skeleton">
              <Skeleton width={30} height={30} />
              <Skeleton width="55%" height={26} />
              <Skeleton width="45%" height={12} />
            </div>
          ))}
        </div>
        <section className="recent-section">
          <Skeleton width={200} height={18} />
          <SkeletonList rows={3} />
        </section>
        <span className="sr-only">Loading dashboard</span>
      </div>
    );
  }

  if (statsQuery.isError) {
    return (
      <div className="page">
        <p className="error-message" role="alert">
          {(statsQuery.error as Error).message}
        </p>
      </div>
    );
  }

  const stats = statsQuery.data;
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
    Icon: STATUS_ICONS[status],
  }));

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p>Overview of your documents</p>
      </header>

      <div className="quick-actions">
        {QUICK_ACTIONS.map(({ to, label, caption, Icon }) => (
          <Link key={to} to={to} className="quick-action">
            <span className="quick-action-icon">
              <Icon />
            </span>
            <strong>{label}</strong>
            <span className="quick-action-caption">{caption}</span>
          </Link>
        ))}
      </div>

      <div className="stats-grid">
        <div className="stat-card stat-total">
          <span className="stat-icon">
            <FileIcon />
          </span>
          <span className="stat-value">{stats.total_documents}</span>
          <span className="stat-label">Documents</span>
        </div>
        {statusCards.map(({ status, label, count, Icon }) => (
          <div key={status} className={`stat-card stat-${status}`}>
            <span className="stat-icon">
              <Icon />
            </span>
            <span className="stat-value">{count}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
        <div className="stat-card stat-chunks">
          <span className="stat-icon">
            <LayersIcon />
          </span>
          <span className="stat-value">{stats.total_chunks}</span>
          <span className="stat-label">Chunks indexed</span>
        </div>
      </div>

      <section className="recent-section">
        <h2>Recently uploaded</h2>
        {stats.recent_documents.length === 0 ? (
          <EmptyState
            title="No documents yet"
            description="Upload your first document to get started."
            action={{ label: "Upload a document", to: "/app/documents" }}
          />
        ) : (
          <ul className="recent-list">
            {stats.recent_documents.map((doc) => (
              <li key={doc.id} className="recent-item">
                <span
                  className={`recent-tile tone-${DOCUMENT_STATUS_TONE[doc.status] ?? "gray"}`}
                  aria-hidden="true"
                >
                  {doc.filename.charAt(0).toUpperCase()}
                </span>
                <span className="recent-filename">{doc.filename}</span>
                <Badge tone={DOCUMENT_STATUS_TONE[doc.status] ?? "gray"}>
                  {STATUS_LABELS[doc.status]}
                </Badge>
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