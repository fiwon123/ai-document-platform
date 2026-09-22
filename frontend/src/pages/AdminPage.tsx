import { memo, useCallback, useEffect, useState } from "react";
import { statistics, users } from "../services/api";
import type { AdminStatisticsResponse, User } from "../types";
import { useAuth } from "../hooks/useAuth";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";

type Role = "customer" | "admin";

interface AdminUserRowProps {
  user: User;
  busyId: string | null;
  isCurrentUser: boolean;
  onRoleChange: (userId: string, role: Role) => void;
  onDelete: (userId: string, username: string) => void;
  onToggleActive: (user: User) => void;
}

/**
 * Memoized admin table row: re-renders only when the user's data or the
 * in-flight action id changes, not on every parent re-render.
 */
const AdminUserRow = memo(function AdminUserRow({
  user,
  busyId,
  isCurrentUser,
  onRoleChange,
  onDelete,
  onToggleActive,
}: AdminUserRowProps) {
  const rowBusy = busyId === user.id;
  return (
    <tr>
      <td>{user.username}</td>
      <td>
        <select
          value={user.role === "admin" ? "admin" : "customer"}
          onChange={(e) =>
            onRoleChange(user.id, e.target.value as Role)
          }
          disabled={rowBusy || isCurrentUser}
          aria-label={`Role for ${user.username}`}
        >
          <option value="customer">customer</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td>
        <div className="user-status-cell">
          <span
            className={`user-status ${
              user.is_active ? "is-active" : "is-disabled"
            }`}
          >
            {user.is_active ? "active" : "disabled"}
          </span>
          <button
            onClick={() => onToggleActive(user)}
            className="btn btn-secondary btn-sm"
            disabled={rowBusy || isCurrentUser}
            aria-label={`${user.is_active ? "Disable" : "Enable"} ${user.username}`}
          >
            {user.is_active ? "Disable" : "Enable"}
          </button>
        </div>
      </td>
      <td>
        {user.created_at
          ? new Date(user.created_at).toLocaleDateString()
          : "—"}
      </td>
      <td>
        <button
          onClick={() => onDelete(user.id, user.username)}
          className="btn btn-danger"
          disabled={rowBusy || isCurrentUser}
        >
          Delete
        </button>
      </td>
    </tr>
  );
});

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const [userList, setUserList] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStatisticsResponse | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);

  const isAdmin = currentUser?.role === "admin";

  const loadUsers = useCallback(async () => {
    try {
      const data = await users.listUsers();
      setUserList(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const data = await statistics.getAdmin();
      setStats(data);
    } catch (err) {
      // Statistics are supplementary — a failure should not block the
      // user management table below, but it must resolve the spinner so
      // the section does not spin forever.
      console.error("Failed to load admin statistics", err);
      setStatsFailed(true);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadUsers();
      void loadStats();
    }
  }, [isAdmin, loadUsers, loadStats]);

  // Handlers use functional setState only, so they are stable across renders
  // and memoized rows are not invalidated by parent re-renders.
  const handleRoleChange = useCallback(async (userId: string, role: Role) => {
    setBusyId(userId);
    setError(null);
    try {
      const updated = await users.updateUserRole(userId, role);
      setUserList((prev) =>
        prev.map((u) =>
          u.id === userId ? { ...u, role: updated.role } : u,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(async (userId: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;

    setBusyId(userId);
    setError(null);
    try {
      await users.deleteUser(userId);
      setUserList((prev) => prev.filter((u) => u.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleToggleActive = useCallback(async (user: User) => {
    setBusyId(user.id);
    setError(null);
    try {
      const updated = await users.updateUserActive(user.id, !user.is_active);
      setUserList((prev) =>
        prev.map((u) =>
          u.id === user.id ? { ...u, is_active: updated.is_active } : u,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusyId(null);
    }
  }, []);

  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Users</h1>
          <p>Admin panel</p>
        </header>
        <p className="error-message">Admin privileges required.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Users</h1>
        <p>Manage accounts and roles</p>
      </header>

      {error && <p className="error-message" role="alert">{error}</p>}

      <section aria-label="System statistics" className="admin-stats">
        {stats ? (
          <div className="stats-grid">
            <div className="stat-card stat-users">
              <span className="stat-value">{stats.total_users}</span>
              <span className="stat-label">Users</span>
            </div>
            <div className="stat-card stat-users">
              <span className="stat-value">{stats.active_users}</span>
              <span className="stat-label">Active</span>
            </div>
            <div className="stat-card stat-users">
              <span className="stat-value">{stats.disabled_users}</span>
              <span className="stat-label">Disabled</span>
            </div>
            <div className="stat-card stat-total">
              <span className="stat-value">{stats.total_documents}</span>
              <span className="stat-label">Documents</span>
            </div>
            <div className="stat-card stat-ready">
              <span className="stat-value">{stats.ready_documents}</span>
              <span className="stat-label">Ready</span>
            </div>
            <div className="stat-card stat-pending">
              <span className="stat-value">{stats.pending_documents}</span>
              <span className="stat-label">Pending</span>
            </div>
            <div className="stat-card stat-processing">
              <span className="stat-value">{stats.processing_documents}</span>
              <span className="stat-label">Processing</span>
            </div>
            <div className="stat-card stat-failed">
              <span className="stat-value">{stats.failed_documents}</span>
              <span className="stat-label">Failed</span>
            </div>
            <div className="stat-card stat-chunks">
              <span className="stat-value">{stats.total_chunks}</span>
              <span className="stat-label">Chunks indexed</span>
            </div>
            <div className="stat-card stat-chunks">
              <span className="stat-value">{stats.total_searches}</span>
              <span className="stat-label">Searches</span>
            </div>
          </div>
        ) : statsFailed ? (
          <p className="error-message" role="alert" aria-label="Statistics unavailable">
            System statistics are currently unavailable.
          </p>
        ) : (
          <div className="loading">
            <Spinner size={18} label="Loading system statistics" />
          </div>
        )}
      </section>

      {isLoading ? (
        <SkeletonList rows={4} />
      ) : userList.length === 0 ? (
        <EmptyState
          title="No users found"
          description="There are no user accounts yet."
        />
      ) : (
        <div className="user-table-wrap">
          <table className="user-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {userList.map((user) => (
                <AdminUserRow
                  key={user.id}
                  user={user}
                  busyId={busyId}
                  isCurrentUser={user.id === currentUser?.id}
                  onRoleChange={handleRoleChange}
                  onDelete={handleDelete}
                  onToggleActive={handleToggleActive}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}