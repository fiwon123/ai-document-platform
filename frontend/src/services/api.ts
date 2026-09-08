import type {
  Document,
  DocumentStatusResponse,
  QAResponse,
  SearchResponse,
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

async function request<T>(
  path: string,
  options: RequestInit = {},
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
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Request failed" }));
    throw new ApiError(response.status, error.detail || "Request failed");
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
};

export const documents = {
  async list(skip = 0, limit = 20): Promise<Document[]> {
    return request<Document[]>(`/?skip=${skip}&limit=${limit}`);
  },

  async get(id: string): Promise<Document> {
    return request<Document>(`/${id}`);
  },

  async getStatus(id: string): Promise<DocumentStatusResponse> {
    return request<DocumentStatusResponse>(`/documents/${id}/status`);
  },

  async upload(file: File): Promise<Document> {
    const formData = new FormData();
    formData.append("upload_file", file);
    return request<Document>("/", { method: "POST", body: formData });
  },

  async delete(id: string): Promise<void> {
    await request<{ message: string }>(`/${id}`, { method: "DELETE" });
  },

  async getDownloadUrl(id: string): Promise<{ id: string; filename: string; download_url: string }> {
    return request(`/documents/${id}/download`);
  },
};

export const search = {
  async search(query: string, topK = 5): Promise<SearchResponse> {
    return request<SearchResponse>("/search/", {
      method: "POST",
      body: JSON.stringify({ query, top_k: topK }),
    });
  },
};

export const qa = {
  async ask(
    question: string,
    documentIds?: string[],
  ): Promise<QAResponse> {
    return request<QAResponse>("/qa/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        document_ids: documentIds || null,
      }),
    });
  },
};
