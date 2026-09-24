import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { users } from "../services/api";
import type { User } from "../types";
import { useAuth } from "../hooks/useAuth";

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
  const isLoading = updateMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (!password && username === user?.username) {
      setError("Nothing to update");
      return;
    }

    try {
      const updated: User = await updateMutation.mutateAsync({
        username,
        password: password || undefined,
        confirmPassword: confirmPassword || undefined,
      });
      updateUser(updated);
      setPassword("");
      setConfirmPassword("");
      setSuccess("Profile updated");
    } catch {
      // The mutation's onError already surfaced the failure.
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Profile</h1>
        <p>Update your account details</p>
      </header>

      <form className="auth-card profile-card" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="profile-username">Username</label>
          <input
            id="profile-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={20}
            pattern="^[a-zA-Z0-9_]+$"
            disabled={isLoading}
          />
        </div>

        <div className="form-group">
          <label htmlFor="profile-password">New password</label>
          <input
            id="profile-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            placeholder="Leave blank to keep current password"
            disabled={isLoading}
          />
        </div>

        <div className="form-group">
          <label htmlFor="profile-confirm-password">Confirm new password</label>
          <input
            id="profile-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
            placeholder="Re-enter the new password"
            disabled={isLoading}
          />
        </div>

        {error && <p className="error-message" role="alert">{error}</p>}
        {success && <p className="success-message">{success}</p>}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isLoading}
        >
          {isLoading ? "Saving..." : "Save changes"}
        </button>
      </form>
    </div>
  );
}