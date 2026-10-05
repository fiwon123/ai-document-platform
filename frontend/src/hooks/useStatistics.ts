import { useQuery } from "@tanstack/react-query";
import { statistics } from "../services/api";

export const MY_STATISTICS_QUERY_KEY = ["statistics", "me"] as const;
export const ADMIN_STATISTICS_QUERY_KEY = ["statistics", "admin"] as const;

/** The current user's dashboard summary. While any recently-uploaded
 *  document is still pending/processing, the summary (and the recent list
 *  with its live badges/progress) is re-fetched on the same cadence the
 *  documents page uses, so the dashboard catches status flips on its own. */
export function useMyStatistics() {
  return useQuery({
    queryKey: MY_STATISTICS_QUERY_KEY,
    queryFn: () => statistics.getMe(),
    // A freshly uploaded document must show up immediately: the summary is
    // invalidated after uploads/deletes, and remounting the dashboard always
    // re-fetches instead of serving the 30s-stale cached copy.
    refetchOnMount: "always",
    refetchInterval: (query) => {
      const recent = query.state.data?.recent_documents ?? [];
      return recent.some(
        (d) => d.status === "pending" || d.status === "processing",
      )
        ? 3000
        : false;
    },
  });
}

/** System-wide aggregates (admin only). */
export function useAdminStatistics(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ADMIN_STATISTICS_QUERY_KEY,
    queryFn: () => statistics.getAdmin(),
    enabled: options?.enabled,
  });
}