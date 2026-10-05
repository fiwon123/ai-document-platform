import { useQuery } from "@tanstack/react-query";
import { documents } from "../services/api";

export const DOCUMENTS_QUERY_KEY = ["documents"] as const;

/**
 * Shared documents list. Used by both DocumentsPage and DocumentFilter, so a
 * single backend request feeds both (TanStack Query dedupes observers with
 * the same key).
 */
export function useDocuments() {
  return useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: () => documents.list(),
  });
}