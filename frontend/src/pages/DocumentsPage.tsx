import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { documents } from "../services/api";
import type { Document, DocumentStatusResponse } from "../types";
import { SkeletonCard } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../context/ToastContext";

/** How often to re-check documents that are still processing. */
const POLL_INTERVAL_MS = 3000;

function isProcessing(status: Document["status"]): boolean {
  return status === "pending" || status === "processing";
}

export function DocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
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

  /** Uploads one or more files sequentially; continues after individual failures. */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;

    setIsUploading(true);
    setError(null);
    let failed = 0;

for (const file of files) {
      try {
        const doc = await documents.upload(file);
        setDocs((prev) => [doc, ...prev]);
        toast.success(`Uploaded "${file.name}" — processing started`);
      } catch (err) {
        failed += 1;
        const message =
          err instanceof Error ? err.message : "unknown error";
        setError(`Upload of "${file.name}" failed: ${message}`);
        toast.error(`Upload of "${file.name}" failed: ${message}`);
      }
    }

    if (failed === 0) toast.success("All documents uploaded");
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

    try {
      await documents.delete(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      toast.success("Document deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function handleDownload(doc: Document) {
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
    }
  }

  const statusColors: Record<string, string> = {
    pending: "#f59e0b",
    processing: "#3b82f6",
    ready: "#10b981",
    failed: "#ef4444",
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Documents</h1>
        <p>Upload and manage your documents</p>
      </header>

      <div className="upload-section">
        <label
          className={`dropzone${isDragging ? " is-dragging" : ""}`}
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
          <small>PDF, TXT, JSON, CSV up to 25 MB each</small>
 (fix: accessibility pass across pages)
        </label>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

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
                  onClick={() => handleDownload(doc)}
                  disabled={doc.status !== "ready"}
                  className="btn btn-secondary"
                >
                  Download
                </button>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="btn btn-danger"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}