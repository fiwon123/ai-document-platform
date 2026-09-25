import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";
import type { ChangeEvent, DragEvent } from "react";
import { documents } from "../services/api";
import type { Document, DocumentPreview, DocumentStatusResponse } from "../types";
import { SkeletonCard } from "../components/Skeleton";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { DOCUMENT_STATUS_TONE } from "../components/documentStatusTone";
import { PreviewModal } from "../components/PreviewModal";
import { RefreshIcon, EyeIcon, DownloadIcon, SearchIcon } from "../components/icons";
import { formatElapsed } from "../utils/time";
import { useToast } from "../hooks/useToast";
import { useDocuments, DOCUMENTS_QUERY_KEY } from "../hooks/useDocuments";
import { MY_STATISTICS_QUERY_KEY } from "../hooks/useStatistics";
import { useQueryClient } from "@tanstack/react-query";

/** How often to re-check documents that are still processing. */
const POLL_INTERVAL_MS = 3000;
/** Maximum files the backend accepts per bulk request. */
const MAX_BULK_UPLOAD_FILES = 20;

/**
 * Stable empty list for `docsQuery.data ?? EMPTY_DOCS`.
 *
 * An inline `?? []` allocates a fresh array on every render, so effects
 * depending on it re-ran each time. Exported for the page's own tests.
 */
const EMPTY_DOCS: Document[] = [];

/** Statuses offered as filter chips, in pipeline order. */
const STATUS_FILTERS: Document["status"][] = [
  "pending",
  "processing",
  "ready",
  "failed",
];

function isProcessing(status: Document["status"]): boolean {
  return status === "pending" || status === "processing";
}

/** Delay before a failed thumbnail lookup is retried (prevents hammering). */
const THUMBNAIL_RETRY_MS = 30_000;

type OptimisticDocumentAction =
  | { type: "delete"; id: string }
  | { type: "reprocess"; id: string }
  | { type: "upload"; files: File[] };

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

interface DocumentCardProps {
  doc: Document;
  thumbnailUrl: string | undefined;
  isPreviewLoading: boolean;
  isDownloading: boolean;
  isDeleting: boolean;
  isReprocessing: boolean;
  onPreview: (doc: Document) => void;
  onDownload: (doc: Document) => void;
  onDelete: (id: string) => void;
  onReprocess: (id: string) => void;
  onThumbnailError: (id: string) => void;
}

/** Uppercase file extension for the placeholder tile (max 4 chars); falls
 *  back to a generic label for dotless or long-extension filenames. */
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "FILE";
  const ext = filename.slice(dot + 1).toUpperCase();
  return ext.length > 4 ? "FILE" : ext;
}

/**
 * Memoized per-document card. During status polling only the documents
 * whose status changed receive new object identities, so unchanged cards
 * skip re-rendering entirely instead of re-rendering the whole grid.
 */
const DocumentCard = memo(function DocumentCard({
  doc,
  thumbnailUrl,
  isPreviewLoading,
  isDownloading,
  isDeleting,
  isReprocessing,
  onPreview,
  onDownload,
  onDelete,
  onReprocess,
  onThumbnailError,
}: DocumentCardProps) {
  return (
    <div className="document-card">
      <div className="document-card-header">
        {thumbnailUrl ? (
          <img
            className="document-thumbnail"
            src={thumbnailUrl}
            alt={`Preview of ${doc.filename}`}
            loading="lazy"
            onError={() => {
              // Expired presigned URL or deleted object: drop the URL so
              // the card falls back to the generic icon.
              onThumbnailError(doc.id);
            }}
          />
        ) : (
          <div className="file-icon" aria-hidden="true">
            {fileExtension(doc.filename)}
          </div>
        )}
        <div className="document-info">
          <h3>{doc.filename}</h3>
          <p>{doc.mime_type || "Unknown type"}</p>
        </div>
      </div>
      <div className="document-card-body">
        <div className="status-row">
          <span>Status:</span>
          <span className="status-badge-group">
            <Badge tone={DOCUMENT_STATUS_TONE[doc.status] ?? "gray"}>
              {doc.status}
            </Badge>
            {isProcessing(doc.status) && (
              <span
                className="status-elapsed"
                title={`${doc.status} for ${formatElapsed(doc.updated_at)}`}
              >
                {formatElapsed(doc.updated_at)}
              </span>
            )}
          </span>
        </div>
        {isProcessing(doc.status) && (
          <span className="progress-track" aria-hidden="true">
            <span className="progress-bar" />
          </span>
        )}
        {doc.error_message && (
          <p className="error-detail">{doc.error_message}</p>
        )}
        <p className="date">
          Uploaded: {new Date(doc.created_at).toLocaleDateString()}
        </p>
      </div>
      <div className="document-card-footer">
        {doc.status === "failed" && (
          <button
            onClick={() => onReprocess(doc.id)}
            disabled={isReprocessing}
            className="btn btn-icon-accent btn-icon-blue btn-icon"
            aria-label="Reprocess document"
            title="Reprocess document"
          >
            {isReprocessing ? (
              <Spinner size={16} label="Reprocessing" />
            ) : (
              <RefreshIcon />
            )}
          </button>
        )}
        <button
          onClick={() => onPreview(doc)}
          disabled={isPreviewLoading}
          className="btn btn-icon-accent btn-icon-violet btn-icon"
          aria-label="Preview document"
          title="Preview document"
        >
          {isPreviewLoading ? (
            <Spinner size={16} label="Loading preview" />
          ) : (
            <EyeIcon />
          )}
        </button>
        <button
          onClick={() => onDownload(doc)}
          disabled={doc.status !== "ready" || isDownloading}
          className="btn btn-icon-accent btn-icon-green btn-icon"
          aria-label="Download document"
          title={
            doc.status !== "ready" ? "Available after processing" : "Download document"
          }
        >
          {isDownloading ? (
            <Spinner size={16} label="Downloading" />
          ) : (
            <DownloadIcon />
          )}
        </button>
        <button
          onClick={() => onDelete(doc.id)}
          disabled={isDeleting}
          className="btn btn-danger btn-icon"
          aria-label="Delete document"
          title="Delete document"
        >
          {isDeleting ? (
            <Spinner size={16} label="Deleting" />
          ) : (
            <TrashIcon />
          )}
        </button>
      </div>
    </div>
  );
});

export function DocumentsPage() {
  const queryClient = useQueryClient();
  // The document list is a shared TanStack Query — DocumentFilter reads the
  // same cache entry, and every mutation below (poll, upload, delete,
  // reprocess) updates it in place so the grid reflects changes instantly.
  const docsQuery = useDocuments();
  // Shared empty fallback so the identity stays stable while the query has no
  // data yet. A `?? []` inline literal would hand the two polling effects a new
  // array on every render, which cleared and re-created the poll interval each
  // time — starving it whenever the page re-rendered faster than POLL_INTERVAL_MS.
  const docs = docsQuery.data ?? EMPTY_DOCS;
  // Optimistic layer: delete/reprocess/upload apply to the visible grid
  // instantly and are dropped again once the real cache update (or a
  // failure) lands. Polling and thumbnails keep reading the non-optimistic
  // `docs` so they only ever touch real documents.
  const [optimisticDocs, addOptimistic] = useOptimistic(
    docs,
    (state, action: OptimisticDocumentAction) => {
    if (action.type === "delete") {
      return state.filter((d) => d.id !== action.id);
    }
    if (action.type === "reprocess") {
      return state.map((d) =>
        d.id === action.id
          ? {
              ...d,
              status: "pending",
              error_message: null,
              // Restart the elapsed timer immediately; the 3s poll then
              // syncs the authoritative value from the backend.
              updated_at: new Date().toISOString(),
            }
          : d,
      );
    }
    // Upload: prepend in-flight placeholder cards for each selected file.
    const files: File[] = action.files;
    const placeholders: Document[] = files.map((file) => ({
      id: `pending-${file.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      owner_id: "",
      filename: file.name,
      object_key: "",
      mime_type: file.type || "application/octet-stream",
      status: "pending",
      error_message: null,
      has_thumbnail: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    return [...placeholders, ...state];
  });
  // addOptimistic must run inside an action (async transition) for React to
  // re-render optimistically.
  const [, startTransition] = useTransition();
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  /** Bumped on every status poll so per-tick work (elapsed labels, thumbnail
   *  retry windows) runs even when the query data itself stops changing:
   *  TanStack Query's structural sharing keeps `docs` referentially stable
   *  once the polled statuses plateau, so effects keyed only on `docs`
   *  would otherwise go quiet. */
  const [pollTick, setPollTick] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [reprocessingId, setReprocessingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Filename search text (client-side filter over the loaded list). */
  const [searchQuery, setSearchQuery] = useState("");
  /** Active status chip, or null when filtering by all statuses. */
  const [statusFilter, setStatusFilter] = useState<Document["status"] | null>(null);
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Ids whose thumbnail URL was fetched successfully (avoids refetching). */
  const thumbnailFetched = useRef<Set<string>>(new Set());
  /** Ids whose last thumbnail lookup failed, timestamped for backoff. */
  const thumbnailFailedAt = useRef<Map<string, number>>(new Map());

  const listError = docsQuery.isError ? (docsQuery.error as Error).message : null;
  const errorMessage = listError ?? error;

  // Client-side filtering: the deferred query keeps the list rendering
  // responsive while typing, and the memos recompute only when the docs,
  // the query, or the active status actually change.
  const deferredQuery = useDeferredValue(searchQuery);
  const filteredDocs = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return optimisticDocs.filter((doc) => {
      const matchesQuery = needle === "" || doc.filename.toLowerCase().includes(needle);
      const matchesStatus = statusFilter === null || doc.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [optimisticDocs, deferredQuery, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<Document["status"], number> = {
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
    };
    for (const doc of optimisticDocs) counts[doc.status] += 1;
    return counts;
  }, [optimisticDocs]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setStatusFilter(null);
  }, []);

  // Poll status of every document that is still pending/processing so the
  // badges update live (after upload or external processing) without a reload.
  // Merges happen through the shared query cache so both the grid and the
  // DocumentFilter on other pages see the freshest status.
  useEffect(() => {
    const active = docs.filter((d) => isProcessing(d.status));
    if (active.length === 0) return;

    const interval = setInterval(async () => {
      let statuses: DocumentStatusResponse[];
      try {
        statuses = await Promise.all(active.map((d) => documents.getStatus(d.id)));
      } catch {
        return; // Transient error — keep polling on the next tick.
      }

      queryClient.setQueryData<Document[]>(DOCUMENTS_QUERY_KEY, (prev) =>
        (prev ?? []).map((doc) => {
          const next = statuses.find((s) => s.id === doc.id);
          if (!next) return doc;
          const changed =
            next.status !== doc.status ||
            next.error_message !== doc.error_message ||
            next.has_thumbnail !== doc.has_thumbnail ||
            next.updated_at !== doc.updated_at;
          if (!changed && !isProcessing(next.status)) {
            // Keep the object identity for unchanged, non-active documents so
            // their memoized cards skip re-rendering on this poll tick.
            return doc;
          }
          // Active documents always get a fresh object so the elapsed-time
          // label re-renders on every poll (identity only matters for cards
          // that are not visibly changing every 3s).
          return {
            ...doc,
            status: next.status,
            error_message: next.error_message,
            has_thumbnail: next.has_thumbnail,
            created_at: next.created_at,
            updated_at: next.updated_at,
          };
        }),
      );
      // Wake the page even when the merged data is structurally identical
      // (active-but-unchanged documents), so elapsed labels and thumbnail
      // retries keep advancing with the clock.
      setPollTick((t) => t + 1);
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [docs, queryClient]);

  // Fetch presigned thumbnail URLs for documents that have one (PDFs that
  // finished processing). Failures are silent — the card keeps its generic
  // icon — and are retried after a short backoff. Polling merges the
  // has_thumbnail flag live, so documents that finish while the page is
  // open are picked up without a full reload.
  useEffect(() => {
    const now = Date.now();
    const toFetch = docs.filter((d) => {
      if (!d.has_thumbnail || thumbnailFetched.current.has(d.id)) return false;
      const failedAt = thumbnailFailedAt.current.get(d.id);
      return failedAt === undefined || now - failedAt >= THUMBNAIL_RETRY_MS;
    });
    for (const doc of toFetch) {
      documents
        .getThumbnailUrl(doc.id)
        .then(({ thumbnail_url }) => {
          // Mark on success so a fulfilled request is never re-issued, even
          // when this effect run was superseded by a polling update. URLs
          // are idempotent per document id, so a late write is harmless
          // (and a post-unmount setState is a no-op in React 19).
          thumbnailFetched.current.add(doc.id);
          setThumbnailUrls((prev) => ({ ...prev, [doc.id]: thumbnail_url }));
        })
        .catch(() => {
          // 404 (no thumbnail) or a transient network error — keep the
          // placeholder until the next retry window.
          thumbnailFailedAt.current.set(doc.id, Date.now());
        });
    }
    // pollTick wakes this effect on every status poll, so a failed lookup is
    // retried once the backoff window elapses even when the docs data (and
    // thus this effect's other dependency) has plateaued.
  }, [docs, pollTick]);

  // Focus management for the preview modal lives in the shared
  // <PreviewModal> component (move focus in, trap Tab, close on Escape,
  // restore focus on close).

  /**
   * Uploads files via the bulk endpoint. Batches larger than the backend
   * limit are split into sequential bulk requests. Per-file failures from
   * the response are reported individually; successful files still appear.
   * The busy flag is set eagerly (before the transition) so the dropzone
   * disables immediately; placeholder cards are shown optimistically while
   * the requests are in flight.
   */
  async function uploadFiles(files: File[]) {
    if (files.length === 0 || isUploading) return;

    setIsUploading(true);
    setError(null);
    startTransition(async () => {
      addOptimistic({ type: "upload", files });
      const errors: string[] = [];
      let uploadedCount = 0;

      const batches: File[][] = [];
      for (let i = 0; i < files.length; i += MAX_BULK_UPLOAD_FILES) {
        batches.push(files.slice(i, i + MAX_BULK_UPLOAD_FILES));
      }

      try {
        for (const batch of batches) {
          try {
            const { uploaded, failed: failures } = await documents.uploadMany(batch);
            if (uploaded.length > 0) {
              queryClient.setQueryData<Document[]>(DOCUMENTS_QUERY_KEY, (prev) => [
                ...uploaded,
                ...(prev ?? []),
              ]);
              uploadedCount += uploaded.length;
            }
            for (const failure of failures) {
              const message = `Upload of "${failure.filename}" failed: ${failure.error}`;
              errors.push(message);
              toast.error(message);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : "unknown error";
            errors.push(`Batch upload failed: ${message}`);
            toast.error(`Batch upload failed: ${message}`);
          }
        }
      } finally {
        setIsUploading(false);
      }

      if (errors.length > 0) setError(errors.join(" "));
      if (uploadedCount > 0) {
        // The document set changed — refresh the dashboard summary so its
        // stat cards and recent list pick up the new upload immediately
        // instead of waiting out the 30s query freshness window.
        queryClient.invalidateQueries({ queryKey: MY_STATISTICS_QUERY_KEY });
        toast.success(
          `${uploadedCount} document${uploadedCount === 1 ? "" : "s"} uploaded — processing started`,
        );
      }
    });
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    void uploadFiles(files);
  }

  /** Opens the hidden file picker, e.g. from the empty-state CTA. */
  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    void uploadFiles(files);
  }

  const handleDelete = useCallback((id: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    // Busy flags are urgent (outside the transition) so the row's delete
    // button disables and shows its spinner immediately.
    setDeletingId(id);
    setError(null);
    startTransition(async () => {
      addOptimistic({ type: "delete", id });
      try {
        await documents.delete(id);
        queryClient.setQueryData<Document[]>(DOCUMENTS_QUERY_KEY, (prev) =>
          (prev ?? []).filter((d) => d.id !== id),
        );
        // Keep the dashboard summary in sync after a deletion.
        queryClient.invalidateQueries({ queryKey: MY_STATISTICS_QUERY_KEY });
        // Drop any cached thumbnail URL so a re-uploaded document with the
        // same id (never happens today, but cheap) cannot show a stale image.
        setThumbnailUrls((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        toast.success("Document deleted");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
        toast.error(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    });
  }, [queryClient, toast, addOptimistic]);

  // All handlers use only stable references (settiers, the API client,
  // toast), so they keep their identity across renders and memoized cards
  // are not invalidated by parent re-renders.

  const handleDownload = useCallback(async (doc: Document) => {
    setDownloadingId(doc.id);
    setError(null);
    try {
      const { download_url, filename } = await documents.getDownloadUrl(doc.id);
      const link = document.createElement("a");
      link.href = download_url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }, []);

  const handlePreview = useCallback(async (doc: Document) => {
    setPreviewLoadingId(doc.id);
    setPreviewError(null);
    try {
      const data = await documents.preview(doc.id);
      setPreview(data);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewLoadingId(null);
    }
  }, []);

  /** Re-enqueue a failed document for processing and start polling it. */
  const handleReprocess = useCallback((id: string) => {
    // Busy flag is urgent (outside the transition) so the row's reprocess
    // button disables and shows its spinner immediately.
    setReprocessingId(id);
    setError(null);
    startTransition(async () => {
      addOptimistic({ type: "reprocess", id });
      try {
        await documents.reprocess(id);
        queryClient.setQueryData<Document[]>(DOCUMENTS_QUERY_KEY, (prev) =>
          (prev ?? []).map((d) =>
            d.id === id
              ? {
                  ...d,
                  status: "pending",
                  error_message: null,
                  // Restart the elapsed timer immediately; the 3s poll then
                  // syncs the authoritative value from the backend.
                  updated_at: new Date().toISOString(),
                }
              : d,
          ),
        );
        toast.success("Document queued for reprocessing");
        // Reprocessing changes status counts (failed → pending) — refresh
        // the dashboard summary so its recent list shows the retry state.
        queryClient.invalidateQueries({ queryKey: MY_STATISTICS_QUERY_KEY });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Reprocessing failed";
        setError(message);
        toast.error(message);
      } finally {
        setReprocessingId(null);
      }
    });
  }, [queryClient, toast, addOptimistic]);

  const clearThumbnailUrl = useCallback((id: string) => {
    setThumbnailUrls((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return (
    <div className="page">
      {/* Content wrapper: the preview modal is its own sibling so the rest
          of the page can be made inert (screen-reader isolation) while the
          dialog is open, without inerting the dialog itself. */}
      <div inert={preview ? true : undefined}>
      <header className="page-header">
        <h1>Documents</h1>
        <p>Upload and manage your documents</p>
      </header>

      <div className="upload-section">
        <label
          className={`dropzone${isDragging ? " is-dragging" : ""}${isUploading ? " is-uploading" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >

          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileChange}
            disabled={isUploading}
          />
          <span className="upload-symbol" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
              <path d="M12 12v9" />
              <path d="m16 16-4-4-4 4" />
            </svg>
          </span>
          <strong>
            {isUploading ? "Uploading…" : "Drop documents here"}
          </strong>
          <span>or choose one or more files from your device</span>
<small>PDF, TXT, JSON, CSV up to 25 MB each (20 files per batch)</small>
        </label>
      </div>

      {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
      {previewError && <p className="error-message" role="alert">{previewError}</p>}

      {optimisticDocs.length > 0 && (
        <div className="documents-toolbar">
          <div className="documents-search">
            <SearchIcon />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by filename"
              aria-label="Search documents by filename"
            />
            {searchQuery && (
              <button
                type="button"
                className="documents-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <div
            className="status-filter"
            role="group"
            aria-label="Filter documents by status"
          >
            <button
              type="button"
              className={`filter-chip${statusFilter === null ? " is-selected" : ""}`}
              aria-pressed={statusFilter === null}
              onClick={() => setStatusFilter(null)}
            >
              All
              <span className="chip-count">{optimisticDocs.length}</span>
            </button>
            {STATUS_FILTERS.filter((status) => statusCounts[status] > 0).map(
              (status) => (
                <button
                  key={status}
                  type="button"
                  className={`filter-chip${statusFilter === status ? " is-selected" : ""}`}
                  aria-pressed={statusFilter === status}
                  onClick={() =>
                    setStatusFilter(statusFilter === status ? null : status)
                  }
                  title={`Show ${status} documents`}
                >
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                  <span className="chip-count">{statusCounts[status]}</span>
                </button>
              ),
            )}
          </div>
          {(searchQuery || statusFilter !== null) && (
            <p className="documents-result-count" role="status">
              Showing {filteredDocs.length} of {optimisticDocs.length} documents
              <button
                type="button"
                className="documents-filter-clear"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </p>
          )}
        </div>
      )}

      {docsQuery.isPending ? (
        <div className="document-grid" aria-busy="true">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : optimisticDocs.length === 0 ? (
        <EmptyState
          title="No documents uploaded yet"
          description="Upload your first document above to start asking questions."
          action={{ label: "Upload a document", onClick: openFilePicker }}
        />
      ) : filteredDocs.length === 0 ? (
        <EmptyState
          title="No documents match your filters"
          description={[
            statusFilter ? `No ${statusFilter} documents` : "No documents",
            searchQuery ? `match "${searchQuery}".` : "match your filters.",
          ].join(" ")}
          action={{ label: "Clear filters", onClick: clearFilters }}
        />
      ) : (
        <div className="document-grid">
          {filteredDocs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              thumbnailUrl={thumbnailUrls[doc.id]}
              isPreviewLoading={previewLoadingId === doc.id}
              isDownloading={downloadingId === doc.id}
              isDeleting={deletingId === doc.id}
              isReprocessing={reprocessingId === doc.id}
              onPreview={handlePreview}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onReprocess={handleReprocess}
              onThumbnailError={clearThumbnailUrl}
            />
          ))}
        </div>
      )}
      </div>

      {preview && (
        <PreviewModal preview={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}