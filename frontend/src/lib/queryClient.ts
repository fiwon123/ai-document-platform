import { QueryClient } from "@tanstack/react-query";

/**
 * Central QueryClient for the app.
 *
 * Defaults are tuned for an interactive dashboard:
 * - `staleTime: 30s` — data is considered fresh for 30s, so navigating
 *   between pages reuses cached responses instead of re-fetching.
 * - `gcTime: 5min` — inactive queries stay in the cache for 5 minutes so
 *   returning tabs render instantly.
 * - `retry: 1` — one transparent retry for transient network/server errors,
 *   but never retry 4xx statuses (the ApiError carries the status).
 * - `refetchOnWindowFocus: false` — the documents page owns its own polling;
 *   background refetches on focus add noise without value here.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});