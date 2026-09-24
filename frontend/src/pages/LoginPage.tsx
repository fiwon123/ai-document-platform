import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ThemeToggle } from "../components/ThemeToggle";
import { FormSubmitButton } from "../components/FormSubmitButton";

interface LoginFieldsProps {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
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
  error,
}: LoginFieldsProps) {
  const { pending } = useFormStatus();
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
        />
      </div>

      <div className="form-group">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

      <FormSubmitButton pendingLabel="Signing in...">Sign In</FormSubmitButton>
    </>
  );
}

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(formData: FormData) {
    setError(null);
    try {
      await login(
        String(formData.get("username") ?? ""),
        String(formData.get("password") ?? ""),
      );
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-theme-toggle">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <h1>Login</h1>
        <p className="auth-subtitle">Sign in to your account</p>

        <form action={handleSubmit}>
          <LoginFields
            username={username}
            onUsernameChange={setUsername}
            password={password}
            onPasswordChange={setPassword}
            error={error}
          />
        </form>

        <p className="auth-footer">
          Don't have an account? <Link to="/register">Register</Link>
        </p>
      </div>
    </div>
  );
}
