import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { applyInitialTheme } from "./hooks/useTheme";

// Before the first render, so the very first paint is already the right colour.
// Anything rendered before the Navbar mounts — the session-loading state most of
// all — would otherwise always be light, because `useTheme` only runs inside
// ThemeToggle (see the note on applyInitialTheme).
applyInitialTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
