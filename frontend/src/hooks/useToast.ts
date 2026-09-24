import { useContext } from "react";

import { ToastContext } from "../context/toastContext";
import type { ToastAPI } from "../context/toastContext";

export function useToast(): ToastAPI {
  return useContext(ToastContext);
}