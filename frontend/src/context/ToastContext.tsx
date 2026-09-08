import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastAPI {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

/** Auto-dismiss delay per kind. */
const TOAST_DURATION_MS: Record<ToastKind, number> = {
  success: 4000,
  error: 5000,
  info: 3500,
};

/** No-op default so components render safely without a provider (e.g. in tests). */
const noop: ToastAPI = {
  success: () => {},
  error: () => {},
  info: () => {},
  dismiss: () => {},
};

const ToastContext = createContext<ToastAPI>(noop);

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

  return (
    <ToastContext.Provider
      value={{
        success: (m) => push("success", m),
        error: (m) => push("error", m),
        info: (m) => push("info", m),
        dismiss,
      }}
    >
      {children}
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map((toast) => (
            <div
              className={`toast toast-${toast.kind}`}
              key={toast.id}
              role="status"
            >
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

export function useToast(): ToastAPI {
  return useContext(ToastContext);
}