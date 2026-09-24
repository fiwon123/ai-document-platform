import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { users } from "../services/api";
import type { User } from "../types";
import { useAuth } from "../hooks/useAuth";
import { FormSubmitButton } from "../components/FormSubmitButton";

interface ProfileFieldsProps {
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
  error: string | null;
  success: string | null;
}

/**
 * Rendered inside the <form> so useFormStatus can disable the fields and swap
 * the submit label while the profile update action is in flight.
 */
function ProfileFields({
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  error,
  success,
}: ProfileFieldsProps) {
  const { pending } = useFormStatus();
  return (
    <>
      <div className="form-group">
        <label htmlFor="profile-username">Username</label>
        <input
          id="profile-username"
          name="profile-username"
          type="text"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          minLength={3}
          maxLength={20}
          pattern="^[a-zA-Z0-9_]+$"
          disabled={pending}
        />
      </div>

      <div className="form-group">
        <label htmlFor="profile-password">New password</label>
        <input
          id="profile-password"
          name="profile-password"
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          minLength={8}
          placeholder="Leave blank to keep current password"
          disabled={pending}
        />
      </div>

      <div className="form-group">
        <label htmlFor="profile-confirm-password">Confirm new password</label>
        <input
          id="profile-confirm-password"
          name="profile-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
          minLength={8}
          placeholder="Re-enter the new password"
          disabled={pending}
        />
      </div>

      {error && <p className="error-message" role="alert">{error}</p>}
      {success && (
        <p className="success-message" role="status">
          {success}
        </p>
      )}

      <FormSubmitButton pendingLabel="Saving...">Save changes</FormSubmitButton>
    </>
  );
}

export function ProfilePage() {
  const { user, updateUser } = useAuth();
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (payload: {
      username: string;
      password?: string;
      confirmPassword?: string;
    }) => users.updateMe(payload),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to update profile");
    },
  });

  async function handleSubmit(formData: FormData) {
    setError(null);
    setSuccess(null);

    const nextPassword = String(formData.get("profile-password") ?? "");
    const nextConfirm = String(formData.get("profile-confirm-password") ?? "");
    const nextUsername = String(formData.get("profile-username") ?? "");

    if (nextPassword !== nextConfirm) {
      setError("Passwords do not match");
      return;
    }

    if (!nextPassword && nextUsername === user?.username) {
      setError("Nothing to update");
      return;
    }

    try {
      const updated: User = await updateMutation.mutateAsync({
        username: nextUsername,
        password: nextPassword || undefined,
        confirmPassword: nextConfirm || undefined,
      });
      updateUser(updated);
      setSuccess("Profile updated");
    } catch {
      // The mutation's onError already surfaced the failure.
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Profile</h1>
        <p>Update your account details</p>
      </header>

      <form className="auth-card profile-card" action={handleSubmit}>
        <ProfileFields
          username={username}
          onUsernameChange={setUsername}
          password={password}
          onPasswordChange={setPassword}
          confirmPassword={confirmPassword}
          onConfirmPasswordChange={setConfirmPassword}
          error={error}
          success={success}
        />
      </form>
    </div>
  );
}