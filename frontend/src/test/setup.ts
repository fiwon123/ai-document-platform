import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

// RTL's auto-cleanup relies on globals being enabled; register it explicitly.
afterEach(() => {
  cleanup();
});