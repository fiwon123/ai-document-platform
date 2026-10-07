import { useQuery } from "@tanstack/react-query";
import { webhooks } from "../services/api";

export const WEBHOOKS_QUERY_KEY = ["webhooks"] as const;

/** The current user's webhook subscriptions. */
export function useWebhooks() {
  return useQuery({
    queryKey: WEBHOOKS_QUERY_KEY,
    queryFn: () => webhooks.list(),
  });
}
