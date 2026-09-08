import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL's auto-cleanup relies on globals being enabled; register it explicitly.
afterEach(() => {
  cleanup();
});