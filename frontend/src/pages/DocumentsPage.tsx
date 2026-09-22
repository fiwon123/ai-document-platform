import { useCallback, useEffect, useRef, useState } from "react";
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

export function DocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
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
          return next
            ? { ...doc, status: next.status, error_message: next.error_message }
            : doc;
        }),
      );
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [docs]);

  // Close the preview modal on Escape (matches the overlay click handler).
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  /**
   * Uploads files via the bulk endpoint. Batches larger than the backend
   * limit are split into sequential bulk requests. Per-file failures from
   * the response are reported individually; successful files still appear.
   */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;

    setIsUploading(true);
    setError(null);
    let failed = 0;

    const batches: File[][] = [];
    for (let i = 0; i < files.length; i += MAX_BULK_UPLOAD_FILES) {
      batches.push(files.slice(i, i + MAX_BULK_UPLOAD_FILES));
    }

    for (const batch of batches) {
      try {
        const { uploaded, failed: failures } = await documents.uploadMany(batch);
        if (uploaded.length > 0) {
          setDocs((prev) => [...uploaded, ...prev]);
        }
        for (const failure of failures) {
          failed += 1;
          const message = `Upload of "${failure.filename}" failed: ${failure.error}`;
          setError(message);
          toast.error(message);
        }
      } catch (err) {
        failed += batch.length;
        const message = err instanceof Error ? err.message : "unknown error";
        setError(`Batch upload failed: ${message}`);
        toast.error(`Batch upload failed: ${message}`);
      }
    }

    const uploadedCount = files.length - failed;
    if (uploadedCount > 0) {
      toast.success(
        `${uploadedCount} document${uploadedCount === 1 ? "" : "s"} uploaded — processing started`,
      );
    }
    setIsUploading(false);
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

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this document?")) return;

    setDeletingId(id);
    setError(null);
    try {
      await documents.delete(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      toast.success("Document deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleDownload(doc: Document) {
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
  }

  async function handlePreview(doc: Document) {
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
  }

  const statusColors: Record<string, string> = {
    // -600 weight shades keep white text WCAG AA (>= 4.5:1) in both themes.
    pending: "#b45309",
    processing: "#2563eb",
    ready: "#16a34a",
    failed: "#dc2626",
  };

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
            <div key={doc.id} className="document-card">
              <div className="document-card-header">
                <div className="file-icon" aria-hidden="true">FILE</div>
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
                  onClick={() => handlePreview(doc)}
                  disabled={previewLoadingId === doc.id}
                  className="btn btn-secondary"
                >
                  {previewLoadingId === doc.id ? (
                    <>
                      <Spinner size={14} label="Loading preview" />
                      Loading…
                    </>
                  ) : (
                    "Preview"
                  )}
                </button>
                <button
                  onClick={() => handleDownload(doc)}
                  disabled={doc.status !== "ready" || downloadingId === doc.id}
                  className="btn btn-secondary"
                >
                  {downloadingId === doc.id ? (
                    <>
                      <Spinner size={14} label="Downloading" />
                      Downloading…
                    </>
                  ) : (
                    "Download"
                  )}
                </button>
                <button
                  onClick={() => handleDelete(doc.id)}
                  disabled={deletingId === doc.id}
                  className="btn btn-danger"
                >
                  {deletingId === doc.id ? (
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
          ))}
        </div>
      )}

      {preview && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview of ${preview.filename}`}
          onClick={() => setPreview(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{preview.filename}</h2>
              <button
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