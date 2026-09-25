import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../hooks/useToast";
import { AuthShell } from "../components/AuthShell";
import { PasswordField } from "../components/auth/PasswordField";
import { FormSubmitButton } from "../components/FormSubmitButton";

export const REMEMBER_KEY = "askdocs-username";

interface LoginFieldsProps {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  remember: boolean;
  onRememberChange: (value: boolean) => void;
  error: string | null;
}

/**
 * Rendered inside the <form> so useFormStatus can disable the fields and swap
 * the submit label while the login action is in flight.
 */
function LoginFields({
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  remember,
  onRememberChange,
  error,
}: LoginFieldsProps) {
  const { pending } = useFormStatus();
  const toast = useToast();

  return (
    <>
      <div className="form-group">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          type="text"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          required
          disabled={pending}
          autoComplete="username"
        />
      </div>

      <PasswordField
        id="password"
        label="Password"
        value={password}
        onChange={onPasswordChange}
        disabled={pending}
        autoComplete="current-password"
      />

      <div className="auth-row">
        <label className="remember-row">
          <input
            type="checkbox"
            name="remember"
            value="yes"
            checked={remember}
            onChange={(e) => onRememberChange(e.target.checked)}
          />
          Remember me
        </label>
        <button
          type="button"
          className="forgot-link"
          onClick={() =>
            toast.info("Password reset is coming soon — contact support to get back in.")
          }
        >
          Forgot password?
        </button>
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

      <FormSubmitButton pendingLabel="Signing in...">Sign In</FormSubmitButton>

      <div className="auth-divider" aria-hidden="true">
        <span>or continue with</span>
      </div>

      <div className="social-buttons">
        <button
          type="button"
          className="social-btn"
          onClick={() => toast.info("Google sign-in is coming soon.")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.39a4.64 4.64 0 0 1-2.01 3.05v2.54h3.25c1.9-1.75 2.97-4.33 2.97-7.43Z"
              fill="#4285F4"
            />
            <path
              d="M12 22c2.72 0 5-.9 6.67-2.43l-3.25-2.54c-.9.6-2.05.96-3.42.96-2.63 0-4.86-1.78-5.65-4.17H3.01v2.62A10 10 0 0 0 12 22Z"
              fill="#34A853"
            />
            <path
              d="M6.35 13.82a6.01 6.01 0 0 1 0-3.84V7.36H3.01a10 10 0 0 0 0 9.08l3.34-2.62Z"
              fill="#FBBC05"
            />
            <path
              d="M12 6.01c1.48 0 2.8.5 3.85 1.5l2.89-2.89A10 10 0 0 0 3.01 7.36l3.34 2.62C7.14 7.79 9.37 6.01 12 6.01Z"
              fill="#EA4335"
            />
          </svg>
          Google
        </button>
        <button
          type="button"
          className="social-btn"
          onClick={() => toast.info("GitHub sign-in is coming soon.")}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
              fill="currentColor"
            />
          </svg>
          GitHub
        </button>
      </div>
    </>
  );
}

export function LoginPage() {
  const [username, setUsername] = useState(
    () => localStorage.getItem(REMEMBER_KEY) ?? "",
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(
    () => localStorage.getItem(REMEMBER_KEY) !== null,
  );
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(formData: FormData) {
    setError(null);
    const usernameValue = String(formData.get("username") ?? "");
    if (formData.get("remember") === "yes") {
      localStorage.setItem(REMEMBER_KEY, usernameValue);
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }

    try {
      await login(
        usernameValue,
        String(formData.get("password") ?? ""),
      );
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <AuthShell title="Login" subtitle="Sign in to your account">
      <form action={handleSubmit}>
        <LoginFields
          username={username}
          onUsernameChange={setUsername}
          password={password}
          onPasswordChange={setPassword}
          remember={remember}
          onRememberChange={setRemember}
          error={error}
        />
      </form>

      <p className="auth-footer">
        Don't have an account? <Link to="/register">Register</Link>
      </p>
    </AuthShell>
  );
}