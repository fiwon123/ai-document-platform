import { useEffect, useRef } from "react";
import type { DocumentPreview } from "../types";

interface PreviewModalProps {
  preview: DocumentPreview;
  onClose: () => void;
}

/**
 * Shared text-preview dialog used by the documents page and the dashboard's
 * recently-uploaded rows. Moves focus into the dialog on open, traps Tab
 * inside it, closes on Escape, and restores focus to the triggering element
 * on close (WCAG 2.4.3 / 2.1.2). The host page is responsible for marking
 * its background content inert while the modal is open.
 */
export function PreviewModal({ preview, onClose }: PreviewModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const modal = closeRef.current?.closest(".modal");
      if (!modal) return;
      const focusables = modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([aria-hidden="true"]), [href], input:not([disabled]):not([aria-hidden="true"]), select:not([disabled]):not([aria-hidden="true"]), textarea:not([disabled]):not([aria-hidden="true"]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
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
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="preview-modal-title">{preview.filename}</h2>
          <button ref={closeRef} type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        <pre className="preview-text">{preview.preview}</pre>
        {preview.truncated && (
          <p className="preview-note">Preview truncated to the first 5000 characters.</p>
        )}
      </div>
    </div>
  );
}
