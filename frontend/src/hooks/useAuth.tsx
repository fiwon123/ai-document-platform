import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { auth } from "../services/api";
import type { User } from "../types";

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (
    username: string,
    password: string,
    confirmPassword: string,
  ) => Promise<void>;
  logout: () => void;
  updateUser: (user: User) => void;
}

/** Refresh the access token shortly BEFORE it expires so requests never 401. */
const REFRESH_BEFORE_EXPIRY_MS = 60_000;
/** Lower bound so an (unlikely) 0/negative expires_in never spins a loop. */
const MIN_REFRESH_DELAY_MS = 5_000;

/** Read the remaining lifetime (seconds) of a JWT from its unverified
 *  payload. Only the `exp` claim is read — the server still validates the
 *  signature on every use. Returns null for malformed tokens. */
function getRemainingLifetime(token: string): number | null {
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp)) return null;
    return exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(
    localStorage.getItem("token"),
  );
  const [isLoading, setIsLoading] = useState(true);
  const refreshTimerRef = useRef<number | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  /** Ask for a new access token before the current one expires. The server
   *  rotates the refresh cookie, so each timer arm uses the fresh lifetime.
   *  A plain function (not memoized) so it can re-arm itself recursively. */
  function scheduleProactiveRefresh(expiresInSeconds: number) {
    clearRefreshTimer();
    const delayMs = Math.max(
      expiresInSeconds * 1000 - REFRESH_BEFORE_EXPIRY_MS,
      MIN_REFRESH_DELAY_MS,
    );
    refreshTimerRef.current = window.setTimeout(() => {
      void auth
        .refresh()
        .then((refreshed) => {
          localStorage.setItem("token", refreshed.access_token);
          setToken(refreshed.access_token);
          // Rotation gives a new expiration — arm the next refresh.
          scheduleProactiveRefresh(refreshed.expires_in);
        })
        .catch(() => {
          // Refresh failed (network/cookie gone). The next API call's 401
          // handler will redirect to login; clear the timer state so a
          // later login can re-arm cleanly.
          refreshTimerRef.current = null;
        });
    }, delayMs);
  }

  useEffect(() => {
    if (token) {
      auth
        .getMe()
        .then((me) => {
          setUser(me);
          // After a page reload with a still-valid token, re-arm the
          // proactive refresh so the session keeps pre-emptively re-arming
          // (the timer is not persisted across reloads).
          const remaining = getRemainingLifetime(token);
          if (remaining !== null) {
            scheduleProactiveRefresh(remaining);
          }
        })
        .catch(() => {
          localStorage.removeItem("token");
          setToken(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => clearRefreshTimer, [clearRefreshTimer]);

  const login = async (username: string, password: string) => {
    const response = await auth.login(username, password);
    localStorage.setItem("token", response.access_token);
    setToken(response.access_token);
    setUser(response.user);
    scheduleProactiveRefresh(response.expires_in);
  };

  const register = async (
    username: string,
    password: string,
    confirmPassword: string,
  ) => {
    await auth.register(username, password, confirmPassword);
  };

  const logout = () => {
    clearRefreshTimer();
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
    // Best-effort: clear the httpOnly refresh cookie server-side.
    void auth.logout().catch(() => undefined);
  };

  const updateUser = (updated: User) => {
    setUser(updated);
  };

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, login, register, logout, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}