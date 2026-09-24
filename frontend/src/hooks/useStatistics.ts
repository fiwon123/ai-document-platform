import { useQuery } from "@tanstack/react-query";
import { statistics } from "../services/api";

export const MY_STATISTICS_QUERY_KEY = ["statistics", "me"] as const;
export const ADMIN_STATISTICS_QUERY_KEY = ["statistics", "admin"] as const;

/** The current user's dashboard summary. */
export function useMyStatistics() {
  return useQuery({
    queryKey: MY_STATISTICS_QUERY_KEY,
    queryFn: () => statistics.getMe(),
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