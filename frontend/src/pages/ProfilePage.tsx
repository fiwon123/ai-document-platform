import { useState } from "react";
import { useFormStatus } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { users } from "../services/api";
import type { User } from "../types";
import { useAuth } from "../hooks/useAuth";
import { useMyStatistics } from "../hooks/useStatistics";
import { FormSubmitButton } from "../components/FormSubmitButton";
import { Badge } from "../components/Badge";

interface FeedbackProps {
  error: string | null;
  success: string | null;
}

function Feedback({ error, success }: FeedbackProps) {
  return (
    <>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="success-message" role="status">
          {success}
        </p>
      )}
    </>
  );
}

/** Username editing: rendered inside its own <form> so useFormStatus only
 *  disables this card while the update action is in flight. */
function AccountFields({
  username,
  onUsernameChange,
  error,
  success,
}: {
  username: string;
  onUsernameChange: (value: string) => void;
} & FeedbackProps) {
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

      <Feedback error={error} success={success} />

      <FormSubmitButton pendingLabel="Saving...">Save changes</FormSubmitButton>
    </>
  );
}

/** Password change: separate form so the two cards save independently. */
function PasswordFields({
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  error,
  success,
}: {
  password: string;
  onPasswordChange: (value: string) => void;
  confirmPassword: string;
  onConfirmPasswordChange: (value: string) => void;
} & FeedbackProps) {
  const { pending } = useFormStatus();
  return (
    <>
      <div className="form-group">
        <label htmlFor="profile-password">New password</label>
        <input
          id="profile-password"
          name="profile-password"
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          minLength={8}
          placeholder="At least 8 characters"
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

      <Feedback error={error} success={success} />

      <FormSubmitButton pendingLabel="Updating...">
        Update password
      </FormSubmitButton>
    </>
  );
}

/** "Member since" label from the account creation date, or null when the
 *  server did not provide one (legacy accounts). */
function memberSinceLabel(createdAt: string | null): string | null {
  if (!createdAt) return null;
  return new Date(createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
}

export function ProfilePage() {
  const { user, updateUser, deleteAccount } = useAuth();
  const navigate = useNavigate();
  const statsQuery = useMyStatistics();
  const stats = statsQuery.data;

  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // Per-card feedback so saving one card never flashes a message in the other.
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountSuccess, setAccountSuccess] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (payload: {
      username?: string;
      password?: string;
      confirmPassword?: string;
    }) => users.updateMe(payload),
    onError: (err, variables) => {
      const message =
        err instanceof Error ? err.message : "Failed to update profile";
      if (variables.password !== undefined) {
        setPasswordError(message);
      } else {
        setAccountError(message);
      }
    },
  });

  async function handleSubmitUsername(formData: FormData) {
    setAccountError(null);
    setAccountSuccess(null);

    const nextUsername = String(formData.get("profile-username") ?? "").trim();
    if (!nextUsername || nextUsername === user?.username) {
      setAccountError("Nothing to update");
      return;
    }

    try {
      const updated: User = await updateMutation.mutateAsync({
        username: nextUsername,
      });
      updateUser(updated);
      setUsername(updated.username);
      setAccountSuccess("Profile updated");
    } catch {
      // The mutation's onError already surfaced the failure.
    }
  }

  async function handleSubmitPassword(formData: FormData) {
    setPasswordError(null);
    setPasswordSuccess(null);

    const nextPassword = String(formData.get("profile-password") ?? "");
    const nextConfirm = String(formData.get("profile-confirm-password") ?? "");

    if (!nextPassword) {
      setPasswordError("Enter a new password");
      return;
    }
    if (nextPassword !== nextConfirm) {
      setPasswordError("Passwords do not match");
      return;
    }

    try {
      const updated: User = await updateMutation.mutateAsync({
        password: nextPassword,
        confirmPassword: nextConfirm,
      });
      updateUser(updated);
      setPassword("");
      setConfirmPassword("");
      setPasswordSuccess("Password updated");
    } catch {
      // The mutation's onError already surfaced the failure.
    }
  }

  async function handleDeleteAccount() {
    setDeleteError(null);
    setDeleting(true);
    try {
      await users.deleteMe();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete account",
      );
      setDeleting(false);
      return;
    }
    deleteAccount();
    navigate("/");
  }

  const joined = memberSinceLabel(user?.created_at ?? null);
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();

  return (
    <div className="page profile-page">
      <header className="page-header">
        <h1>Profile</h1>
        <p>Manage your account and keep your data secure</p>
      </header>

      <section className="profile-hero" aria-label="Account overview">
        <span className="avatar-initials avatar-lg" aria-hidden="true">
          {initial}
        </span>
        <div className="profile-hero-meta">
          <h2 className="profile-name">{user?.username ?? "—"}</h2>
          <Badge tone={user?.role === "admin" ? "green" : "blue"}>
            {user?.role ?? "customer"}
          </Badge>
          {joined && <p className="member-since">Member since {joined}</p>}
        </div>
      </section>

      <div className="profile-grid">
        <section className="settings-card">
          <h2>Account info</h2>
          <p className="settings-desc">
            Your username and a summary of what is stored under this account.
          </p>

          <div className="profile-stats">
            <div className="profile-stat">
              <span className="profile-stat-value">
                {stats?.total_documents ?? "—"}
              </span>
              <span className="profile-stat-label">Documents</span>
            </div>
            <div className="profile-stat">
              <span className="profile-stat-value">
                {stats?.total_chunks ?? "—"}
              </span>
              <span className="profile-stat-label">Chunks</span>
            </div>
            <div className="profile-stat">
              <span className="profile-stat-value">{joined ?? "—"}</span>
              <span className="profile-stat-label">Member since</span>
            </div>
          </div>

          <form action={handleSubmitUsername}>
            <AccountFields
              username={username}
              onUsernameChange={setUsername}
              error={accountError}
              success={accountSuccess}
            />
          </form>
        </section>

        <section className="settings-card">
          <h2>Security</h2>
          <p className="settings-desc">
            Change your account password. You will keep the current password
            until the change is saved.
          </p>

          <form action={handleSubmitPassword}>
            <PasswordFields
              password={password}
              onPasswordChange={setPassword}
              confirmPassword={confirmPassword}
              onConfirmPasswordChange={setConfirmPassword}
              error={passwordError}
              success={passwordSuccess}
            />
          </form>
        </section>

        <section className="settings-card danger-zone">
          <h2>Danger zone</h2>
          <p className="settings-desc">
            Permanently delete your account, documents, and search history.
            This cannot be undone.
          </p>

          {!confirmingDelete ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete account
            </button>
          ) : (
            <div className="danger-confirm">
              <p className="danger-warning" role="alert">
                Are you sure? Deleting the account removes all of your
                documents and cannot be reversed.
              </p>
              {deleteError && (
                <p className="error-message" role="alert">
                  {deleteError}
                </p>
              )}
              <div className="danger-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={handleDeleteAccount}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Yes, permanently delete my account"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}