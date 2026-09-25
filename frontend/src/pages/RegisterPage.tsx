import { useState } from "react";
import { useFormStatus } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { AuthShell } from "../components/AuthShell";
import { PasswordField } from "../components/auth/PasswordField";
import { FormSubmitButton } from "../components/FormSubmitButton";

export const TERMS_ERROR = "Please accept the Terms of Service to continue.";

interface RegisterFieldsProps {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  termsAccepted: boolean;
  onTermsChange: (value: boolean) => void;
  error: string | null;
  termsError: string | null;
}

/**
 * Live password guidance: 4-segment strength meter (one segment per check,
 * plus a length-12 bonus), a requirements checklist, and a match indicator.
 */
function usePasswordChecks(password: string) {
  const checks = {
    length: password.length >= 8,
    mixed: /[a-z]/.test(password) && /[A-Z]/.test(password),
    digit: /\d/.test(password),
    extra: password.length >= 12,
  };
  const segments = [checks.length, checks.mixed, checks.digit, checks.extra];
  const lit = segments.filter(Boolean).length;
  const level =
    lit === 0 ? "none" : lit === 1 ? "weak" : lit === 2 ? "fair" : lit === 3 ? "good" : "strong";
  const label =
    lit === 0 ? "No password yet" : `Password strength: ${level}`;
  const percent = Math.round((lit / segments.length) * 100);
  return { checks, lit, level, label, percent };
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
  termsAccepted,
  onTermsChange,
  error,
  termsError,
}: RegisterFieldsProps) {
  const { pending } = useFormStatus();
  const { checks, lit, level, label, percent } = usePasswordChecks(password);
  const showChecks = password.length > 0;
  const showMatch = password.length > 0 && confirmPassword.length > 0;
  const passwordsMatch =
    password.length > 0 && confirmPassword.length > 0 && password === confirmPassword;

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
          autoComplete="username"
        />
      </div>

      <PasswordField
        id="password"
        label="Password"
        value={password}
        onChange={onPasswordChange}
        disabled={pending}
        minLength={8}
        autoComplete="new-password"
      />

      {showChecks && (
        <div
          className={`strength-meter strength-${level}`}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={`strength-seg${index < lit ? " lit" : ""}`}
            />
          ))}
        </div>
      )}

      {showChecks && (
        <ul className="password-checks">
          <li className={checks.length ? "met" : ""}>
            <span className="check-dot" aria-hidden="true" /> At least 8 characters
          </li>
          <li className={checks.mixed ? "met" : ""}>
            <span className="check-dot" aria-hidden="true" /> Upper &amp; lower case letters
          </li>
          <li className={checks.digit ? "met" : ""}>
            <span className="check-dot" aria-hidden="true" /> At least one number
          </li>
        </ul>
      )}

      <PasswordField
        id="confirmPassword"
        label="Confirm Password"
        value={confirmPassword}
        onChange={onConfirmPasswordChange}
        disabled={pending}
        autoComplete="new-password"
      />

      {showMatch && (
        <p
          className={`match-indicator ${passwordsMatch ? "match-ok" : "match-bad"}`}
          role="status"
        >
          {passwordsMatch ? (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path
                d="M18 6 6 18M6 6l12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          )}
          {passwordsMatch ? "Passwords match" : "Passwords don't match"}
        </p>
      )}

      <div className="terms-row">
        <label className="terms-label">
          <input
            type="checkbox"
            name="terms"
            value="yes"
            checked={termsAccepted}
            onChange={(e) => onTermsChange(e.target.checked)}
            disabled={pending}
          />
          I agree to the Terms of Service and Privacy Policy.
        </label>
      </div>
      {termsError && <p className="error-message" role="alert">{termsError}</p>}

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
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const { register } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(formData: FormData) {
    setError(null);
    setTermsError(null);

    if (formData.get("terms") !== "yes") {
      setTermsError(TERMS_ERROR);
      return;
    }

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
    <AuthShell title="Register" subtitle="Create a new account">
      <form action={handleSubmit}>
        <RegisterFields
          username={username}
          onUsernameChange={setUsername}
          password={password}
          onPasswordChange={setPassword}
          confirmPassword={confirmPassword}
          onConfirmPasswordChange={setConfirmPassword}
          termsAccepted={termsAccepted}
          onTermsChange={setTermsAccepted}
          error={error}
          termsError={termsError}
        />
      </form>

      <p className="auth-footer">
        Already have an account? <Link to="/login">Login</Link>
      </p>
    </AuthShell>
  );
}