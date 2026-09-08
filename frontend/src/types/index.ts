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
  user: User;
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
}

export interface QAResponse {
  question: string;
  answer: string;
  sources: SearchResult[];
}
