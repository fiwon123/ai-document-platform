import type { BadgeTone } from "./Badge";

/**
 * Document status → badge tone, so every page maps a status to the same
 * colour instead of repeating the mapping. Falls back to `gray` at the call
 * site for unknown statuses (e.g. old or provider-specific values).
 *
 * Lives apart from `Badge.tsx` so that module exports only the component:
 * a component file that also exports a plain constant disables Fast Refresh,
 * which turns every edit to `Badge` into a full reload of the page.
 */
export const DOCUMENT_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "amber",
  processing: "blue",
  ready: "green",
  failed: "red",
};
