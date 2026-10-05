import { createContext } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastAPI {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: number) => void;
}

/** No-op default so components render safely without a provider (e.g. in tests). */
export const noopToastAPI: ToastAPI = {
  success: () => {},
  error: () => {},
  info: () => {},
  dismiss: () => {},
};

export const ToastContext = createContext<ToastAPI>(noopToastAPI);