import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthProvider";
import { useAuth } from "./useAuth";
import type { User } from "../types";
import { auth } from "../services/api";

vi.mock("../services/api", () => ({
  auth: {
    login: vi.fn(),
    register: vi.fn(),
    getMe: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(),
  },
}));

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

  it("clears an invalid stored token when hydration fails", async () => {
    localStorage.setItem("token", makeToken(3600));
    mockedGetMe.mockRejectedValue(new Error("Session expired"));

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