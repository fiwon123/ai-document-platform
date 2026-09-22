import type {
  AdminStatisticsResponse,
  BulkUploadResponse,
  Document,
  DocumentPreview,
  DocumentStatusResponse,
  QAResponse,
  SearchResponse,
  StatisticsResponse,
  TokenResponse,
  User,
} from "../types";

const API_BASE = "/v1";

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = RequestInit & { _retried?: boolean };

/** Deduped in-flight refresh call: concurrent 401s share one request. */
let refreshPromise: Promise<TokenResponse | null> | null = null;

async function refreshAccessToken(): Promise<TokenResponse | null> {
  try {
    // No Authorization header and no retry: the refresh cookie is the auth.
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) return null;
    return (await response.json()) as TokenResponse;
  } catch {
    return null;
  }
}

function getRefreshPromise(): Promise<TokenResponse | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = localStorage.getItem("token");

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    // Refresh-token cookie must be sent on same-origin requests (Vite proxy
    // in dev; same domain in production).
    credentials: "include",
  });

  if (!response.ok) {
    if (
      response.status === 401 &&
      !options._retried &&
      // Login failures come from bad credentials, not an expired session —
      // replaying through a refresh would only mask the real error.
      path !== "/auth/login"
    ) {
      // Try to mint a fresh access token from the refresh cookie, then
      // replay the original request once. If refresh fails, the session
      // is gone — clear the token and send the user back to login.
      const refreshed = await getRefreshPromise();
      if (refreshed) {
        localStorage.setItem("token", refreshed.access_token);
        return request<T>(path, { ...options, _retried: true });
      }
      localStorage.removeItem("token");
      window.location.href = "/login";
      throw new ApiError(401, "Session expired. Please log in again.");
    }

    const error = await response.json().catch(() => ({ detail: "Request failed" }));
    // Support both the legacy `{detail}` and the standardized
    // `{error: {code, message}}` response shapes.
    const message =
      error?.detail ?? error?.error?.message ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const auth = {
  async login(username: string, password: string): Promise<TokenResponse> {
    const formData = new URLSearchParams();
    formData.append("username", username);
    formData.append("password", password);

    return request<TokenResponse>("/auth/login", {
      method: "POST",
      body: formData,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },

  async register(
    username: string,
    password: string,
    confirmPassword: string,
  ): Promise<User> {
    return request<User>("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username,
        password,
        confirm_password: confirmPassword,
      }),
    });
  },

  async getMe(): Promise<User> {
    return request<User>("/auth/me");
  },

  /** Mint a fresh access token from the httpOnly refresh cookie. */
  async refresh(): Promise<TokenResponse> {
    const refreshed = await getRefreshPromise();
    if (!refreshed) {
      throw new ApiError(401, "Session expired. Please log in again.");
    }
    return refreshed;
  },

  /** Ask the server to clear the httpOnly refresh cookie. */
  async logout(): Promise<void> {
    // _retried: never retry/redirect on 401 — the cookie is already gone.
    await request<void>("/auth/logout", { method: "POST", _retried: true });
  },
};

export const documents = {
  async list(skip = 0, limit = 20): Promise<Document[]> {
    return request<Document[]>(`/documents/?skip=${skip}&limit=${limit}`);
  },

  async get(id: string): Promise<Document> {
    return request<Document>(`/documents/${id}`);
  },

  async getStatus(id: string): Promise<DocumentStatusResponse> {
    return request<DocumentStatusResponse>(`/documents/${id}/status`);
  },

  async upload(file: File): Promise<Document> {
    const formData = new FormData();
    formData.append("upload_file", file);
    return request<Document>("/documents/", { method: "POST", body: formData });
  },

  /** Upload several files in one request. Returns per-file results (partial success is normal). */
  async uploadMany(files: File[]): Promise<BulkUploadResponse> {
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }
    return request<BulkUploadResponse>("/documents/bulk", { method: "POST", body: formData });
  },

  async delete(id: string): Promise<void> {
    await request<{ message: string }>(`/documents/${id}`, { method: "DELETE" });
  },

  async getDownloadUrl(id: string): Promise<{ id: string; filename: string; download_url: string }> {
    return request(`/documents/${id}/download`);
  },

  async preview(id: string): Promise<DocumentPreview> {
    return request<DocumentPreview>(`/documents/${id}/preview`);
  },
};

export const statistics = {
  async getMe(): Promise<StatisticsResponse> {
    return request<StatisticsResponse>("/statistics/me");
  },

  /** System-wide aggregates — admin only (403 for customers). */
  async getAdmin(): Promise<AdminStatisticsResponse> {
    return request<AdminStatisticsResponse>("/statistics/admin");
  },
};

export interface UpdateMeInput {
  username?: string;
  password?: string;
  confirmPassword?: string;
}

export const users = {
  async updateMe(input: UpdateMeInput): Promise<User> {
    const body: Record<string, string> = {};
    if (input.username) {
      body["username"] = input.username;
    }
    if (input.password) {
      body["password"] = input.password;
      body["confirm_password"] = input.confirmPassword ?? "";
    }
    return request<User>("/users/me", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  async listUsers(): Promise<User[]> {
    return request<User[]>("/users/");
  },

  async updateUserRole(userId: string, role: "customer" | "admin"): Promise<User> {
    return request<User>(`/users/${userId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  },

  async updateUserActive(userId: string, isActive: boolean): Promise<User> {
    return request<User>(`/users/${userId}/active`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: isActive }),
    });
  },

  async deleteUser(userId: string): Promise<void> {
    await request<void>(`/users/${userId}`, { method: "DELETE" });
  },
};

export const search = {
  async search(
    query: string,
    topK = 5,
    documentIds: string[] = [],
    offset = 0,
  ): Promise<SearchResponse> {
    return request<SearchResponse>("/search/", {
      method: "POST",
      body: JSON.stringify({
        query,
        top_k: topK,
        offset,
        document_ids: documentIds.length > 0 ? documentIds : null,
      }),
    });
  },

  /** Download a search's results as a CSV or JSON file. */
  async exportResults(
    query: string,
    format: "csv" | "json",
    documentIds: string[] = [],
    topK = 5,
  ): Promise<void> {
    const response = await doExport(query, format, documentIds, topK);
    if (response.status === 401 && !localStorage.getItem("token")) {
      // The session may have expired while the user was browsing — refresh
      // silently and retry once, mirroring the shared request() helper.
      const refreshed = await getRefreshPromise();
      if (refreshed) {
        localStorage.setItem("token", refreshed.access_token);
        const retry = await doExport(query, format, documentIds, topK);
        return handleExportResponse(retry, format);
      }
    }
    return handleExportResponse(response, format);
  },
};

async function doExport(
  query: string,
  format: "csv" | "json",
  documentIds: string[],
  topK: number,
): Promise<Response> {
  const token = localStorage.getItem("token");
  return fetch(`${API_BASE}/search/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify({
      query,
      top_k: topK,
      offset: 0,
      document_ids: documentIds.length > 0 ? documentIds : null,
      format,
    }),
  });
}

async function handleExportResponse(response: Response, format: "csv" | "json") {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Export failed" }));
    const message =
      error?.detail ?? error?.error?.message ?? `Export failed (${response.status})`;
    throw new ApiError(response.status, message);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename =
    disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `search_results.${format}`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface QAModels {
  free: string[];
  paid: string[];
}

export const qa = {
  async ask(
    question: string,
    documentIds?: string[],
    model?: string,
  ): Promise<QAResponse> {
    // Bring-your-own-key: send the user's key (stored in localStorage by
    // the Settings page) so the backend can route this request through it.
    const apiKey = localStorage.getItem("askdocs-api-key");
    return request<QAResponse>("/qa/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        document_ids: documentIds || null,
        model: model ?? null,
        api_key: apiKey || null,
      }),
    });
  },

  async getModels(): Promise<QAModels> {
    return request<QAModels>("/qa/models");
  },
};
