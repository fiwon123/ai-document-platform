import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ToastContext } from "./toastContext";
import type { Toast, ToastAPI, ToastKind } from "./toastContext";

/** Auto-dismiss delay per kind. */
const TOAST_DURATION_MS: Record<ToastKind, number> = {
  success: 4000,
  error: 5000,
  info: 3500,
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), TOAST_DURATION_MS[kind]);
    },
    [dismiss],
  );

  // Stable API object: `push` and `dismiss` are useCallback-stable, so the
  // value keeps its identity across provider re-renders. Consumers can then
  // depend on `toast` in their own useCallback deps safely.
  const api = useMemo<ToastAPI>(
    () => ({
      success: (m) => push("success", m),
      error: (m) => push("error", m),
      info: (m) => push("info", m),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map((toast) => (
            <div className={`toast toast-${toast.kind}`} key={toast.id} role="status">
              <span className="toast-text">{toast.message}</span>
              <button
                type="button"
                className="toast-close"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
