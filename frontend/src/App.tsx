import { useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import "./App.css";

type DocumentResult = {
  id: string;
  filename: string;
  mime_type: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  created_at: string;
};

function App() {
  const [document, setDocument] = useState<DocumentResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadFile(file: File) {
    setIsUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append("upload_file", file);

    try {
      const response = await fetch("/v1/documents/", { method: "POST", body: formData });
      if (!response.ok) throw new Error("The document could not be uploaded.");
      setDocument((await response.json()) as DocumentResult);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Something went wrong.");
    } finally {
      setIsUploading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void uploadFile(file);
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand-mark">AD</div>
        <div>
          <p className="eyebrow">Document intelligence</p>
          <h1>Analyze a document</h1>
        </div>
        <span className="status-dot">Local workspace</span>
      </header>
      <section className="content-grid">
        <div className="intro">
          <p className="kicker">01 / Upload</p>
          <h2>Turn a file into a clear starting point.</h2>
          <p className="lede">
            Upload your source document and we will prepare it for structured AI analysis.
          </p>
          <label
            className={`dropzone${isDragging ? " is-dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <input type="file" onChange={handleFileChange} disabled={isUploading} />
            <span className="upload-symbol">+</span>
            <strong>{isUploading ? "Uploading..." : "Drop a document here"}</strong>
            <span>or choose a file from your device</span>
            <small>PDF, DOCX, TXT up to 25 MB</small>
          </label>
          {error && <p className="error-message">{error}</p>}
        </div>
        <aside className="result-panel">
          <div className="panel-heading">
            <p className="kicker">02 / Result</p>
            <span className="step-number">A</span>
          </div>
          {document ? (
            <div className="document-result">
              <div className="file-icon">FILE</div>
              <h3>{document.filename}</h3>
              <p className="result-meta">{document.mime_type || "Document"}</p>
              <div className="progress-row">
                <span>Analysis status</span>
                <strong>{document.status}</strong>
              </div>
              <div className="progress-track">
                <span />
              </div>
              <p className="result-note">Your file is stored and ready for the analysis worker.</p>
            </div>
          ) : (
            <div className="empty-result">
              <span className="empty-line" />
              <p>Your first result will appear here after upload.</p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

export default App;
