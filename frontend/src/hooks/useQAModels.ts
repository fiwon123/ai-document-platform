import { useQuery } from "@tanstack/react-query";
import { qa } from "../services/api";

export const QA_MODELS_QUERY_KEY = ["qa", "models"] as const;

/** Available free/paid QA models, cached per session. */
export function useQAModels() {
  return useQuery({
    queryKey: QA_MODELS_QUERY_KEY,
    queryFn: () => qa.getModels(),
  });
}