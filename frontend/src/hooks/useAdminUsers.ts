import { useQuery } from "@tanstack/react-query";
import { users } from "../services/api";

export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;

/** All user accounts (admin only). */
export function useAdminUsers(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ADMIN_USERS_QUERY_KEY,
    queryFn: () => users.listUsers(),
    enabled: options?.enabled,
  });
}
