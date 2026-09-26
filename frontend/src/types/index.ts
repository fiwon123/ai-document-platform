export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export type UserRole = "customer" | "admin";

export interface User {
  id: string;
  username: string;
  is_active: boolean;
  role: UserRole | null;
  created_at: string | null;
}

export interface Document {
  id: string;
  owner_id: string;
  filename: string;
  object_key: string;
  mime_type: string | null;
  status: DocumentStatus;
  error_message: string | null;
  has_thumbnail: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThumbnailUrlResponse {
  id: string;
  thumbnail_url: string;
}

export interface DocumentStatusResponse {
  id: string;
  status: DocumentStatus;
  error_message: string | null;
  has_thumbnail: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

export interface DocumentPreview {
  id: string;
  filename: string;
  preview: string;
  truncated: boolean;
}

export interface BulkUploadFailure {
  filename: string;
  error: string;
}

export interface BulkUploadResponse {
  uploaded: Document[];
  failed: BulkUploadFailure[];
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  content: string;
  score: number;
  metadata_: Record<string, unknown> | null;
}

export type SearchMode = "semantic" | "keyword";

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_count: number;
  has_more: boolean;
  /**
   * How these results were found. `keyword` means no embedding provider is
   * configured, so matching is literal rather than semantic. Older backends
   * omit it, hence the optional-with-default on the read side.
   */
  mode?: SearchMode;
}

export interface QAResponse {
  question: string;
  answer: string;
  sources: SearchResult[];
  model: string | null;
  /**
   * How the grounding passages were retrieved. `keyword` means no embedding
   * provider is configured, so the model is reasoning over passages literal
   * matching happened to find and the answer is degraded for that reason.
   */
  mode?: SearchMode;
}

export interface RecentDocument {
  id: string;
  filename: string;
  status: DocumentStatus;
  created_at: string;
}

export interface StatisticsResponse {
  total_documents: number;
  pending_documents: number;
  processing_documents: number;
  ready_documents: number;
  failed_documents: number;
  total_chunks: number;
  recent_documents: RecentDocument[];
}

export interface AdminStatisticsResponse {
  total_users: number;
  active_users: number;
  disabled_users: number;
  total_documents: number;
  pending_documents: number;
  processing_documents: number;
  ready_documents: number;
  failed_documents: number;
  total_chunks: number;
  total_searches: number;
}

export type WebhookEvent =
  | "document.processing"
  | "document.ready"
  | "document.failed"
  | "document.deleted";

export interface WebhookSubscription {
  id: string;
  url: string;
  events: WebhookEvent[];
  is_active: boolean;
  /** HMAC signing secret — share it with your receiver to verify payloads. */
  secret: string;
  last_status: "success" | "failed" | null;
  last_status_code: number | null;
  last_delivered_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookTestResult {
  delivered: boolean;
  event: string;
  status_code: number | null;
  message: string;
}
