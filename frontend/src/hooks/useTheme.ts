import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "askdocs-theme";
/** How long the theme-transition class stays on <html> after a toggle.
 *  Kept short so the color flip feels snappy instead of laggy. */
const THEME_TRANSITION_MS = 220;

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Put the resolved theme on `<html>` before React renders anything.
 *
 * `useTheme` applies it in an effect, but the only component that calls
 * `useTheme` is `ThemeToggle`, which lives in the app Navbar — and the Navbar
 * mounts only once the session is verified. Until then `<html>` carries no
 * `data-theme`, so the page renders in the stylesheet's default (light). That
 * is a white flash for a dark-mode user on first paint, and on any screen shown
 * *before* the Navbar exists — including the session-loading state, which a
 * rate-limited or briefly unreachable backend can hold someone on (#579).
 *
 * Setting it here makes the first paint the right colour. `useTheme` still owns
 * toggling, and re-applies the same value on mount, which is idempotent.
 */
export function applyInitialTheme(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = getInitialTheme();
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const transitionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    // Animate the color switch: the .theme-transitioning class lets CSS
    // interpolate background/color/border for the duration of the flip,
    // then the class is removed so normal per-element transitions resume.
    const root = document.documentElement;
    root.classList.add("theme-transitioning");
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      root.classList.remove("theme-transitioning");
      transitionTimerRef.current = null;
    }, THEME_TRANSITION_MS);

    setTheme((current) => (current === "light" ? "dark" : "light"));
  }, []);

  return { theme, toggleTheme };
}