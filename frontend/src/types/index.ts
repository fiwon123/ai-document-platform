export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface User {
  id: string;
  username: string;
  is_active: boolean;
  role: string | null;
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
  created_at: string;
  updated_at: string;
}

export interface DocumentStatusResponse {
  id: string;
  status: DocumentStatus;
  error_message: string | null;
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

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_count: number;
  has_more: boolean;
}

export interface QAResponse {
  question: string;
  answer: string;
  sources: SearchResult[];
  model: string | null;
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
