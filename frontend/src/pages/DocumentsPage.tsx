import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { documents } from "../services/api";
import type { Document, DocumentStatusResponse } from "../types";
import { SkeletonCard } from "../components/Skeleton";

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
      } catch (err) {
        failed += 1;
        setError(
          `Upload of "${file.name}" failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }

    setIsUploading(false);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    void uploadFiles(files);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
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
            onChange={handleFileChange}
            disabled={isUploading}
          />
          <span className="upload-symbol">+</span>
          <strong>
            {isUploading ? "Uploading…" : "Drop documents here"}
          </strong>
          <span>or choose one or more files from your device</span>
          <small>PDF, TXT, JSON, CSV up to 25 MB each</small>
        </label>
      </div>

      {error && <p className="error-message">{error}</p>}

      {isLoading ? (
        <div className="document-grid" aria-busy="true">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : docs.length === 0 ? (
        <div className="empty-state">
          <p>No documents uploaded yet. Upload your first document above.</p>
        </div>
      ) : (
        <div className="document-grid">
          {docs.map((doc) => (
            <div key={doc.id} className="document-card">
              <div className="document-card-header">
                <div className="file-icon">FILE</div>
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