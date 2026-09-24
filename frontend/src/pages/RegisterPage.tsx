import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { ThemeToggle } from "../components/ThemeToggle";
import { FormSubmitButton } from "../components/FormSubmitButton";

interface RegisterFieldsProps {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  error: string | null;
}

/**
 * Rendered inside the <form> so useFormStatus can disable the fields and swap
 * the submit label while the registration action is in flight.
 */
function RegisterFields({
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  error,
}: RegisterFieldsProps) {
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
          minLength={3}
          maxLength={20}
          pattern="^[a-zA-Z0-9_]+$"
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
          minLength={8}
          disabled={pending}
        />
      </div>

      <div className="form-group">
        <label htmlFor="confirmPassword">Confirm Password</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
          required
          disabled={pending}
        />
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}

      <FormSubmitButton pendingLabel="Creating account...">
        Register
      </FormSubmitButton>
    </>
  );
}

export function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(formData: FormData) {
    setError(null);
    const nextPassword = String(formData.get("password") ?? "");
    const nextConfirm = String(formData.get("confirmPassword") ?? "");
    if (nextPassword !== nextConfirm) {
      setError("Passwords do not match");
      return;
    }

    try {
      await register(
        String(formData.get("username") ?? ""),
        nextPassword,
        nextConfirm,
      );
      navigate("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-theme-toggle">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <h1>Register</h1>
        <p className="auth-subtitle">Create a new account</p>

        <form action={handleSubmit}>
          <RegisterFields
            username={username}
            onUsernameChange={setUsername}
            password={password}
            onPasswordChange={setPassword}
            confirmPassword={confirmPassword}
            onConfirmPasswordChange={setConfirmPassword}
            error={error}
          />
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}