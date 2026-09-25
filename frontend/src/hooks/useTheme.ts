import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "askdocs-theme";
/** How long the theme-transition class stays on <html> after a toggle. */
const THEME_TRANSITION_MS = 400;

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
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