import type {
  AdminStatisticsResponse,
  BulkUploadResponse,
  Document,
  DocumentPreview,
  DocumentStatusResponse,
  QAResponse,
  SearchResponse,
  StatisticsResponse,
  ThumbnailUrlResponse,
  TokenResponse,
  User,
  WebhookEvent,
  WebhookSubscription,
  WebhookTestResult,
} from "../types";

const API_BASE = "/v1";

/** The `details` object the backend attaches to a standardized error. */
export type ErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  status: number;
  /**
   * The stable machine-readable code (`provider_rate_limited`,
   * `rate_limit_exceeded`, `validation_error`, …).
   *
   * Kept because the message is for people and this is for the program: the UI
   * needs to tell "wait a moment" apart from "this will never work" without
   * pattern-matching English. Absent for the legacy `{detail}` shape and for
   * responses with no body, so every read of it is optional.
   */
  code?: string;
  details?: ErrorDetails;
  /**
   * Seconds to wait before retrying.
   *
   * The `Retry-After` header is preferred — it is the interoperable signal, the
   * one a proxy or any other client reads — and the body's `retry_after` is the
   * fallback for when a proxy dropped it. Accepts both forms the header may
   * take (a delay in seconds, or an HTTP date) and resolves them here, so the
   * field means "how long to wait" whichever source answered.
   */
  retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    extra: { code?: string; details?: ErrorDetails; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = extra.code;
    this.details = extra.details;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

/** What a caller needs to explain a rate limit and offer a retry. */
export interface RateLimitInfo {
  /** Seconds until the limit is expected to reset, if the server said. */
  retryAfterSeconds?: number;
  /** Which provider refused, when the error named one. */
  provider?: string;
  /** What was exhausted: the per-minute or per-day budget. */
  scope?: string;
  /** Whether the refusal came from our own ceiling or the provider's. */
  source?: string;
}

/** `Retry-After` is either a delay in seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

function str(details: ErrorDetails | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

function num(details: ErrorDetails | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The rate-limit facts for an error, or null when it is not a rate limit.
 *
 * One helper rather than per-call-site checks, so every surface describes a rate
 * limit the same way and a future third caller cannot forget a field.
 *
 * Both codes are handled: `provider_rate_limited` is the LLM provider refusing,
 * and `rate_limit_exceeded` is the app's own per-IP limiter. They mean the same
 * thing to a user — come back shortly — while differing in whether a retry will
 * help sooner or is already known to have hit a shared provider budget.
 */
export function rateLimitFrom(error: unknown): RateLimitInfo | null {
  if (!(error instanceof ApiError)) return null;
  if (
    error.code !== "provider_rate_limited" &&
    error.code !== "rate_limit_exceeded"
  ) {
    return null;
  }
  return {
    retryAfterSeconds: error.retryAfterSeconds,
    provider: str(error.details, "provider"),
    scope: str(error.details, "scope"),
    source: str(error.details, "source"),
  };
}

/** A rate limit in words a user can act on, without an internal provider id. */
export function describeRateLimit(info: RateLimitInfo): string {
  const wait = info.retryAfterSeconds;
  const when = wait === undefined ? "" : ` Try again in about ${wait} second${wait === 1 ? "" : "s"}.`;

  // The provider id stays out of the user-facing text on purpose: "groq" is an
  // internal name, and showing it makes a temporary limit look like a broken
  // backend. The source distinguishes our ceiling from the provider's, which is
  // the part that tells a user whether waiting is likely to help.
  if (info.source === "provider") {
    return `The AI provider's own rate limit was reached, so this is temporary.${when}`;
  }
  if (info.scope === "tokens" || info.scope === "tokens_per_day") {
    return `The AI provider's request allowance for today is used up, so this is temporary.${when}`;
  }
  return `Too many questions in a short time. Please wait a moment.${when}`;
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

/**
 * Core fetch with shared auth handling: attaches the Bearer token from
 * localStorage, sends the refresh cookie, and transparently mints a fresh
 * access token via the refresh endpoint when a request comes back 401 (then
 * replays the original request once). Every API call — JSON or file download —
 * flows through here so the refresh logic lives in exactly one place.
 */
async function fetchWithAuth(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
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

  if (
    response.status === 401 &&
    !options._retried &&
    // Login failures come from bad credentials, not an expired session —
    // replaying through a refresh would only mask the real error.
    path !== "/auth/login"
  ) {
    // Try to mint a fresh access token from the refresh cookie, then replay
    // the original request once. If refresh fails, the session is gone —
    // clear the token and send the user back to login.
    const refreshed = await getRefreshPromise();
    if (refreshed) {
      localStorage.setItem("token", refreshed.access_token);
      return fetchWithAuth(path, { ...options, _retried: true });
    }
    localStorage.removeItem("token");
    window.location.href = "/login";
    throw new ApiError(401, "Session expired. Please log in again.");
  }

  return response;
}

/** Shared error parsing for non-2xx responses (JSON body or fallback). */
async function parseError(response: Response, fallback: string): Promise<ApiError> {
  // A body that is absent or not JSON (a proxy's HTML error page, an empty
  // 502) still has to produce the caller's fallback rather than "[object
  // Object]", so an unparsable body is treated as `{detail: fallback}` exactly
  // as before — that is where a useful message comes from.
  const parsed = await response.json().catch(() => undefined);
  const body = parsed ?? { detail: fallback };
  // Support both the legacy `{detail}` and the standardized
  // `{error: {code, message, details}}` response shapes.
  const message =
    body?.detail ??
    body?.error?.message ??
    `Request failed (${response.status})`;

  const details =
    body?.error?.details && typeof body.error.details === "object"
      ? (body.error.details as ErrorDetails)
      : undefined;
  const code = typeof body?.error?.code === "string" ? body.error.code : undefined;

  return new ApiError(response.status, message, {
    code,
    details,
    // The header wins because it is the interoperable signal, but the body
    // carries the same fact and a proxy can drop the header. Deciding the
    // precedence here — rather than in each caller — means `retryAfterSeconds`
    // means "how long to wait" whichever source answered.
    retryAfterSeconds:
      parseRetryAfter(response.headers.get("retry-after")) ??
      num(details, "retry_after"),
  });
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetchWithAuth(path, options);

  if (!response.ok) {
    throw await parseError(response, "Request failed");
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

  /** Re-enqueue a failed (or ready) document for processing. */
  async reprocess(id: string): Promise<{
    message: string;
    document_id: string;
    status: string;
  }> {
    return request<{ message: string; document_id: string; status: string }>(
      `/documents/${id}/reprocess`,
      { method: "POST" },
    );
  },

  async getDownloadUrl(id: string): Promise<{ id: string; filename: string; download_url: string }> {
    return request(`/documents/${id}/download`);
  },

  /** Presigned URL of the document's rendered thumbnail (404 when none). */
  async getThumbnailUrl(id: string): Promise<ThumbnailUrlResponse> {
    return request<ThumbnailUrlResponse>(`/documents/${id}/thumbnail`);
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

  /** Delete the current user's own account. */
  async deleteMe(): Promise<void> {
    await request<void>("/users/me", { method: "DELETE" });
  },
};

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEvent[];
  is_active?: boolean;
}

export const webhooks = {
  async list(): Promise<WebhookSubscription[]> {
    return request<WebhookSubscription[]>("/webhooks/");
  },

  async create(url: string, events: WebhookEvent[]): Promise<WebhookSubscription> {
    return request<WebhookSubscription>("/webhooks/", {
      method: "POST",
      body: JSON.stringify({ url, events }),
    });
  },

  async update(id: string, input: UpdateWebhookInput): Promise<WebhookSubscription> {
    return request<WebhookSubscription>(`/webhooks/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  async remove(id: string): Promise<void> {
    await request<void>(`/webhooks/${id}`, { method: "DELETE" });
  },

  /** Deliver a one-off ping to verify the receiver endpoint. */
  async test(id: string): Promise<WebhookTestResult> {
    return request<WebhookTestResult>(`/webhooks/${id}/test`, { method: "POST" });
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
    // Goes through fetchWithAuth so the 401-refresh-replay and auth header
    // logic is shared with every other API call.
    const response = await fetchWithAuth("/search/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        top_k: topK,
        offset: 0,
        document_ids: documentIds.length > 0 ? documentIds : null,
        format,
      }),
    });

    if (!response.ok) {
      throw await parseError(response, "Export failed");
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
