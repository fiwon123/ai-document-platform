import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

/**
 * Fresh QueryClient per render: queries never leak between tests and every
 * failed fetch surfaces immediately (retry: false).
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: 0 },
    },
  });
}

/** Renders `ui` inside a QueryClientProvider with a fresh client. */
export function renderWithClient(ui: ReactElement): ReturnType<typeof render> {
  return render(<QueryClientProvider client={createTestQueryClient()}>{ui}</QueryClientProvider>);
}
