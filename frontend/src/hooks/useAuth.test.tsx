import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./useAuth";
import type { User } from "../types";
import { ApiError, auth } from "../services/api";

vi.mock("../services/api", async (importOriginal) => {
  // Spread the real module so `ApiError` is the genuine class: the provider
  // decides "is this an auth failure?" with `error instanceof ApiError`, and a
  // stub class would make that check silently wrong — which is precisely the
  // distinction these tests exist to pin down.
  const actual =
    await importOriginal<typeof import("../services/api")>();
  return {
    ...actual,
    auth: {
      login: vi.fn(),
      register: vi.fn(),
      getMe: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
    },
  };
});

const mockedLogin = vi.mocked(auth.login);
const mockedRegister = vi.mocked(auth.register);
const mockedGetMe = vi.mocked(auth.getMe);
const mockedRefresh = vi.mocked(auth.refresh);
const mockedLogout = vi.mocked(auth.logout);

const testUser: User = {
  id: "user-1",
  username: "alice",
  is_active: true,
  role: "customer",
  created_at: "2026-09-08T00:00:00Z",
};

/** Build a fake JWT whose `exp` claim lies `expiresIn` seconds in the future. */
function makeToken(expiresIn: number): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = btoa(JSON.stringify({ sub: "user-1", exp: nowSec + expiresIn }));
  return `${header}.${payload}.signature`;
}

/** Exposes the auth context through DOM nodes + buttons for assertions. */
function Harness() {
  const { user, token, isLoading, login, register, logout, deleteAccount } =
    useAuth();
  return (
    <div>
      <span data-testid="user">{user ? user.username : "none"}</span>
      <span data-testid="token">{token ?? "none"}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <button onClick={() => login("alice", "s3cret")}>login</button>
      <button onClick={() => register("bob", "s3cret", "s3cret")}>register</button>
      <button onClick={logout}>logout</button>
      <button onClick={deleteAccount}>delete-account</button>
    </div>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
}

describe("useAuth", () => {
  beforeEach(() => {
    localStorage.removeItem("token");
    vi.clearAllMocks();
    // Login/reload set a token, which triggers the getMe hydration effect;
    // default it to success so the effect never faults in unrelated tests.
    mockedGetMe.mockResolvedValue(testUser);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when used outside of an AuthProvider", () => {
    expect(() => render(<Harness />)).toThrow(
      "useAuth must be used within an AuthProvider",
    );
  });

  it("renders children and exposes no session when there is no token", async () => {
    renderAuth();
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("token").textContent).toBe("none");
  });

  it("shows isLoading while hydrating and clears it when a token is present", async () => {
    localStorage.setItem("token", makeToken(3600));
    mockedGetMe.mockResolvedValue(testUser);

    renderAuth();
    expect(mockedGetMe).toHaveBeenCalledTimes(1);
    // Assert the loading state reaches false after the promise resolves.
    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("loads the current user when a stored token exists", async () => {
    localStorage.setItem("token", makeToken(3600));
    mockedGetMe.mockResolvedValue(testUser);

    renderAuth();

    expect(await screen.findByText("alice")).toBeTruthy();
  });

  it("clears an invalid stored token when hydration is rejected as unauthorized", async () => {
    localStorage.setItem("token", makeToken(3600));
    // A 401 — the server saying this token is not valid. This used to be a
    // bare `new Error("Session expired")`, which is precisely the bug: with no
    // status to read, every failure looked like an invalid session (#579).
    mockedGetMe.mockRejectedValue(
      new ApiError(401, "Could not validate credentials"),
    );

    renderAuth();

    expect(await screen.findByText("none")).toBeTruthy();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("does not call getMe at all when there is no token", () => {
    renderAuth();
    expect(mockedGetMe).not.toHaveBeenCalled();
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("stores the token and user on login", async () => {
    mockedGetMe.mockResolvedValue(testUser);
    mockedLogin.mockResolvedValue({
      access_token: "access-token-1",
      token_type: "bearer",
      expires_in: 3600,
      user: testUser,
    });

    renderAuth();
    act(() => {
      screen.getByText("login").click();
    });

    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByTestId("token").textContent).toBe("access-token-1");
    expect(localStorage.getItem("token")).toBe("access-token-1");
    expect(mockedLogin).toHaveBeenCalledWith("alice", "s3cret");
  });

  it("calls register with the provided credentials", async () => {
    mockedRegister.mockResolvedValue(testUser);

    renderAuth();
    screen.getByText("register").click();

    await act(async () => {});
    expect(mockedRegister).toHaveBeenCalledWith("bob", "s3cret", "s3cret");
  });

  it("clears the session and best-effort revokes the refresh cookie on logout", async () => {
    localStorage.setItem("token", makeToken(3600));
    mockedGetMe.mockResolvedValue(testUser);
    mockedLogout.mockResolvedValue(undefined);

    renderAuth();
    expect(await screen.findByText("alice")).toBeTruthy();

    act(() => {
      screen.getByText("logout").click();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(localStorage.getItem("token")).toBeNull();
    expect(mockedLogout).toHaveBeenCalledTimes(1);
  });

  it("removes the stored bring-your-own LLM key on logout", async () => {
    localStorage.setItem("token", makeToken(3600));
    // A real provider key, paid for by the user, sitting in the origin's storage.
    localStorage.setItem("askdocs-api-key", "sk-user-provider-key");
    mockedGetMe.mockResolvedValue(testUser);
    mockedLogout.mockResolvedValue(undefined);

    renderAuth();
    expect(await screen.findByText("alice")).toBeTruthy();

    act(() => {
      screen.getByText("logout").click();
    });

    expect(localStorage.getItem("askdocs-api-key")).toBeNull();
  });

  it("removes the stored bring-your-own LLM key on account deletion", async () => {
    localStorage.setItem("token", makeToken(3600));
    localStorage.setItem("askdocs-api-key", "sk-user-provider-key");
    mockedGetMe.mockResolvedValue(testUser);

    renderAuth();
    await screen.findByText("alice");

    act(() => {
      screen.getByText("delete-account").click();
    });

    // Deleting the account promises to remove the user's data; a paid
    // third-party credential must not outlive it on disk.
    expect(localStorage.getItem("askdocs-api-key")).toBeNull();
  });

  it("clears the local session on account deletion without calling logout", async () => {
    localStorage.setItem("token", makeToken(3600));
    mockedGetMe.mockResolvedValue(testUser);

    renderAuth();
    await screen.findByText("alice");
    expect(screen.getByTestId("token").textContent).not.toBe("none");

    act(() => {
      screen.getByText("delete-account").click();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("token").textContent).toBe("none");
    expect(localStorage.getItem("token")).toBeNull();
    // The server already deletes the account + refresh cookie; the client
    // must not attempt a best-effort logout on top.
    expect(mockedLogout).not.toHaveBeenCalled();
  });

  it("refreshes the access token proactively when it is about to expire", async () => {
    vi.useFakeTimers();
    // expires_in = 65s → delay = max(65_000 - 60_000, 5_000) = 5_000ms
    mockedLogin.mockResolvedValue({
      access_token: "access-1",
      token_type: "bearer",
      expires_in: 65,
      user: testUser,
    });
    mockedRefresh.mockResolvedValue({
      access_token: "access-2",
      token_type: "bearer",
      expires_in: 65,
      user: testUser,
    });

    renderAuth();
    screen.getByText("login").click();
    await act(async () => {});

    // Nothing yet before the scheduled window.
    expect(mockedRefresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(mockedRefresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("token")).toBe("access-2");
  });

  it("re-arms the refresh timer with the rotated token's lifetime", async () => {
    vi.useFakeTimers();
    mockedLogin.mockResolvedValue({
      access_token: "access-1",
      token_type: "bearer",
      expires_in: 65,
      user: testUser,
    });
    mockedRefresh
      .mockResolvedValueOnce({
        access_token: "access-2",
        token_type: "bearer",
        expires_in: 65,
        user: testUser,
      })
      .mockResolvedValueOnce({
        access_token: "access-3",
        token_type: "bearer",
        expires_in: 65,
        user: testUser,
      });

    renderAuth();
    screen.getByText("login").click();
    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);

    // A second 65s window must trigger another refresh (rotation re-arms).
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("token")).toBe("access-3");
  });

  it("stops proactively refreshing after a failed refresh attempt", async () => {
    vi.useFakeTimers();
    mockedLogin.mockResolvedValue({
      access_token: "access-1",
      token_type: "bearer",
      expires_in: 65,
      user: testUser,
    });
    mockedRefresh.mockRejectedValue(new Error("Refresh cookie gone"));

    renderAuth();
    screen.getByText("login").click();
    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    // No re-arm: advancing another window must not produce another call.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    // The old token is kept — expiry is handled by the 401 interceptor.
    expect(localStorage.getItem("token")).toBe("access-1");
  });

  it("re-arms the proactive refresh after a page reload with a valid token", async () => {
    vi.useFakeTimers();
    // Remaining lifetime 65s → delay 5s.
    localStorage.setItem("token", makeToken(65));
    mockedGetMe.mockResolvedValue(testUser);
    mockedRefresh.mockResolvedValue({
      access_token: "access-2",
      token_type: "bearer",
      expires_in: 65,
      user: testUser,
    });

    renderAuth();
    await act(async () => {});
    expect(mockedRefresh).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("token")).toBe("access-2");
  });

  it("clears the timer on unmount so no refresh fires after logout", () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(65));
    mockedGetMe.mockResolvedValue(testUser);

    const { unmount } = renderAuth();
    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});

/**
 * #579 — "the Documents page fails to load".
 *
 * The reported symptom was a page that never rendered. The cause was that
 * *any* rejection of `GET /auth/me` was read as "the session is over": the
 * access token was deleted and the router sent the user to /login without
 * them ever having logged out. A `429` is not an authentication failure — the
 * server was busy — and neither is a `5xx` or a dropped connection.
 *
 * These tests pin the distinction that was missing: only a `401` may destroy a
 * session.
 */
describe("AuthProvider — a transient /auth/me failure is not a sign-out", () => {
  function Harness() {
    const { user, isLoading } = useAuth();
    if (isLoading) return <p>loading</p>;
    return <p>{user ? `signed in as ${user.username}` : "signed out"}</p>;
  }

  function renderAuth() {
    return render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );
  }

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the token when /auth/me is rate limited, and recovers", async () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe
      .mockRejectedValueOnce(
        new ApiError(429, "Too many requests.", {
          code: "rate_limit_exceeded",
          retryAfterSeconds: 30,
        }),
      )
      .mockResolvedValueOnce(testUser);

    renderAuth();
    await act(async () => {});

    // The token is still there — this is the whole point of the fix.
    expect(localStorage.getItem("token")).not.toBeNull();

    // And the provider retries rather than giving up: the outage is transient,
    // so the user gets in as soon as the backend answers again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockedGetMe).toHaveBeenCalledTimes(2);
    expect(screen.getByText("signed in as alice")).toBeTruthy();
    expect(localStorage.getItem("token")).not.toBeNull();
  });

  it("keeps the token when /auth/me fails with a 5xx", async () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe
      .mockRejectedValueOnce(new ApiError(503, "Service unavailable."))
      .mockResolvedValueOnce(testUser);

    renderAuth();
    await act(async () => {});

    expect(localStorage.getItem("token")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("signed in as alice")).toBeTruthy();
    expect(localStorage.getItem("token")).not.toBeNull();
  });

  it("keeps the token when /auth/me fails because the network dropped", async () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(testUser);

    renderAuth();
    await act(async () => {});

    expect(localStorage.getItem("token")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByText("signed in as alice")).toBeTruthy();
  });

  it("backs off between retries instead of hammering an unreachable server", async () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe.mockRejectedValue(new ApiError(503, "Service unavailable."));

    renderAuth();
    await act(async () => {});
    expect(mockedGetMe).toHaveBeenCalledTimes(1);

    // First backoff is 1s, so nothing fires before it elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(mockedGetMe).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedGetMe).toHaveBeenCalledTimes(2);

    // The delay doubles: 2s, not another 1s. A backend that is genuinely down
    // must not be polled at a rate that costs more than the outage it is in.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(mockedGetMe).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedGetMe).toHaveBeenCalledTimes(3);

    // And the token is still intact after all of it.
    expect(localStorage.getItem("token")).not.toBeNull();
  });

  it("stops retrying once the component unmounts", async () => {
    vi.useFakeTimers();
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe.mockRejectedValue(new ApiError(503, "Service unavailable."));

    const { unmount } = renderAuth();
    await act(async () => {});
    expect(mockedGetMe).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // No stray retries against a backend the user has already navigated away from.
    expect(mockedGetMe).toHaveBeenCalledTimes(1);
  });

  it("DOES sign the user out when /auth/me answers 401", async () => {
    localStorage.setItem("token", makeToken(1_800));
    mockedGetMe.mockRejectedValue(
      new ApiError(401, "Could not validate credentials"),
    );

    renderAuth();
    await act(async () => {});

    // A 401 is the server saying the token is not valid — the one case where
    // dropping the token is the honest response.
    expect(localStorage.getItem("token")).toBeNull();
    expect(screen.getByText("signed out")).toBeTruthy();
    // And it must not keep retrying a token the server has already refused.
    expect(mockedGetMe).toHaveBeenCalledTimes(1);
  });
});