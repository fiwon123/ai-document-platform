import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// RTL's auto-cleanup relies on globals being enabled; register it explicitly.
afterEach(() => {
  cleanup();
});

// jsdom does not implement matchMedia, but useTheme() reads
// `prefers-color-scheme` on mount. Stub it with a light-system default; tests
// that care can redefine it (see Navbar.test.tsx).
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});