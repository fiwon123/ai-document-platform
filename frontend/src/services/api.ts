import type {
  Document,
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
    // If the server returns 401, the token is invalid or expired.
    // Clear it and redirect to login so the user can re-authenticate.
    if (response.status === 401) {
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

  async delete(id: string): Promise<void> {
    await request<{ message: string }>(`/documents/${id}`, { method: "DELETE" });
  },

  async getDownloadUrl(id: string): Promise<{ id: string; filename: string; download_url: string }> {
    return request(`/documents/${id}/download`);
  },
};

export const statistics = {
  async getMe(): Promise<StatisticsResponse> {
    return request<StatisticsResponse>("/statistics/me");
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

  async deleteUser(userId: string): Promise<void> {
    await request<void>(`/users/${userId}`, { method: "DELETE" });
  },
};

export const search = {
  async search(
    query: string,
    topK = 5,
    documentIds: string[] = [],
  ): Promise<SearchResponse> {
    return request<SearchResponse>("/search/", {
      method: "POST",
      body: JSON.stringify({
        query,
        top_k: topK,
        document_ids: documentIds.length > 0 ? documentIds : null,
      }),
    });
  },
};

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
    return request<QAResponse>("/qa/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        document_ids: documentIds || null,
        model: model ?? null,
      }),
    });
  },

  async getModels(): Promise<QAModels> {
    return request<QAModels>("/qa/models");
  },
};
