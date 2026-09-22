import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { documents } from "../services/api";
import type { Document, DocumentPreview, DocumentStatusResponse } from "../types";
import { SkeletonCard } from "../components/Skeleton";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../context/ToastContext";

/** How often to re-check documents that are still processing. */
const POLL_INTERVAL_MS = 3000;

/** Maximum files the backend accepts per bulk request. */
const MAX_BULK_UPLOAD_FILES = 20;

function isProcessing(status: Document["status"]): boolean {
  return status === "pending" || status === "processing";
}

/** Delay before a failed thumbnail lookup is retried (prevents hammering). */
const THUMBNAIL_RETRY_MS = 30_000;

const statusColors: Record<string, string> = {
  // -600 weight shades keep white text WCAG AA (>= 4.5:1) in both themes.
  pending: "#b45309",
  processing: "#2563eb",
  ready: "#16a34a",
  failed: "#dc2626",
};

interface DocumentCardProps {
  doc: Document;
  thumbnailUrl: string | undefined;
  isPreviewLoading: boolean;
  isDownloading: boolean;
  isDeleting: boolean;
  onPreview: (doc: Document) => void;
  onDownload: (doc: Document) => void;
  onDelete: (id: string) => void;
  onThumbnailError: (id: string) => void;
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
  onPreview,
  onDownload,
  onDelete,
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
          <div className="file-icon" aria-hidden="true">FILE</div>
        )}
        <div className="document-info">
          <h3>{doc.filename}</h3>
          <p>{doc.mime_type || "Unknown type"}</p>
        </div>
      </div>
      <div className="document-card-body">
        <div className="status-row">
          <span>Status:</span>
          <span
            className="status-badge"
            style={{ backgroundColor: statusColors[doc.status] || "#6b7280" }}
          >
            {doc.status}
          </span>
        </div>
        {doc.error_message && (
          <p className="error-detail">{doc.error_message}</p>
        )}
        <p className="date">
          Uploaded: {new Date(doc.created_at).toLocaleDateString()}
        </p>
      </div>
      <div className="document-card-footer">
        <button
          onClick={() => onPreview(doc)}
          disabled={isPreviewLoading}
          className="btn btn-secondary"
        >
          {isPreviewLoading ? (
            <>
              <Spinner size={14} label="Loading preview" />
              Loading…
            </>
          ) : (
            "Preview"
          )}
        </button>
        <button
          onClick={() => onDownload(doc)}
          disabled={doc.status !== "ready" || isDownloading}
          className="btn btn-secondary"
        >
          {isDownloading ? (
            <>
              <Spinner size={14} label="Downloading" />
              Downloading…
            </>
          ) : (
            "Download"
          )}
        </button>
        <button
          onClick={() => onDelete(doc.id)}
          disabled={isDeleting}
          className="btn btn-danger"
        >
          {isDeleting ? (
            <>
              <Spinner size={14} label="Deleting" />
              Deleting…
            </>
          ) : (
            "Delete"
          )}
        </button>
      </div>
    </div>
  );
});

export function DocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Ids whose thumbnail URL was fetched successfully (avoids refetching). */
  const thumbnailFetched = useRef<Set<string>>(new Set());
  /** Ids whose last thumbnail lookup failed, timestamped for backoff. */
  const thumbnailFailedAt = useRef<Map<string, number>>(new Map());

  const loadDocuments = useCallback(async () => {
    try {
      const data = await documents.list();
      setDocs(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  // Poll status of every document that is still pending/processing so the
  // badges update live (after upload or external processing) without a reload.
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

      setDocs((prev) =>
        prev.map((doc) => {
          const next = statuses.find((s) => s.id === doc.id);
          if (
            !next ||
            (next.status === doc.status &&
              next.error_message === doc.error_message &&
              next.has_thumbnail === doc.has_thumbnail)
          ) {
            // Keep the object identity for unchanged documents so their
            // memoized cards skip re-rendering on this poll tick.
            return doc;
          }
          return {
            ...doc,
            status: next.status,
            error_message: next.error_message,
            has_thumbnail: next.has_thumbnail,
          };
        }),
      );
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [docs]);

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
  }, [docs]);

  // Focus management for the preview modal: move focus into the dialog on
  // open, trap Tab inside it, close on Escape, and restore focus to the
  // triggering element on close (WCAG 2.4.3 / 2.1.2).
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!preview) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    previewCloseRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
        return;
      }
      if (event.key !== "Tab") return;
      const modal = previewCloseRef.current?.closest(".modal");
      if (!modal) return;
      const focusables = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus after the dialog unmounts.
      previouslyFocused?.focus?.();
    };
  }, [preview]);

  /**
   * Uploads files via the bulk endpoint. Batches larger than the backend
   * limit are split into sequential bulk requests. Per-file failures from
   * the response are reported individually; successful files still appear.
   */
  async function uploadFiles(files: File[]) {
    if (files.length === 0 || isUploading) return;

    setIsUploading(true);
    setError(null);
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
            setDocs((prev) => [...uploaded, ...prev]);
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
      toast.success(
        `${uploadedCount} document${uploadedCount === 1 ? "" : "s"} uploaded — processing started`,
      );
    }
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

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm("Are you sure you want to delete this document?")) return;

    setDeletingId(id);
    setError(null);
    try {
      await documents.delete(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
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
  }, [toast]);

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

  const clearThumbnailUrl = useCallback((id: string) => {
    setThumbnailUrls((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return (
    <div className="page">
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
          <span className="upload-symbol" aria-hidden="true">+</span>
          <strong>
            {isUploading ? "Uploading…" : "Drop documents here"}
          </strong>
          <span>or choose one or more files from your device</span>
<small>PDF, TXT, JSON, CSV up to 25 MB each (20 files per batch)</small>
        </label>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}
      {previewError && <p className="error-message" role="alert">{previewError}</p>}

      {isLoading ? (
        <div className="document-grid" aria-busy="true">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          title="No documents uploaded yet"
          description="Upload your first document above to start asking questions."
          action={{ label: "Upload a document", onClick: openFilePicker }}
        />
      ) : (
        <div className="document-grid">
          {docs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              thumbnailUrl={thumbnailUrls[doc.id]}
              isPreviewLoading={previewLoadingId === doc.id}
              isDownloading={downloadingId === doc.id}
              isDeleting={deletingId === doc.id}
              onPreview={handlePreview}
              onDownload={handleDownload}
              onDelete={handleDelete}
              onThumbnailError={clearThumbnailUrl}
            />
          ))}
        </div>
      )}

      {preview && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-modal-title"
          onClick={() => setPreview(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 id="preview-modal-title">{preview.filename}</h2>
              <button
                ref={previewCloseRef}
                type="button"
                className="btn btn-secondary"
                onClick={() => setPreview(null)}
              >
                Close
              </button>
            </div>
            <pre className="preview-text">{preview.preview}</pre>
            {preview.truncated && (
              <p className="preview-note">
                Preview truncated to the first 5000 characters.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}