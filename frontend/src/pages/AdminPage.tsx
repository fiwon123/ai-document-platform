import { memo, useCallback, useState, useOptimistic, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { users } from "../services/api";
import type { User } from "../types";
import { useAuth } from "../hooks/useAuth";
import { useAdminStatistics } from "../hooks/useStatistics";
import { useAdminUsers, ADMIN_USERS_QUERY_KEY } from "../hooks/useAdminUsers";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";

type Role = "customer" | "admin";

interface AdminUserRowProps {
  user: User;
  isBusy: boolean;
  isCurrentUser: boolean;
  onRoleChange: (userId: string, role: Role) => void;
  onDelete: (userId: string, username: string) => void;
  onToggleActive: (user: User) => void;
}

/**
 * Memoized admin table row: re-renders only when the user's data or the
 * in-flight action for THIS row changes, not on every parent re-render.
 */
const AdminUserRow = memo(function AdminUserRow({
  user,
  isBusy,
  isCurrentUser,
  onRoleChange,
  onDelete,
  onToggleActive,
}: AdminUserRowProps) {
  return (
    <tr>
      <td>{user.username}</td>
      <td>
        <select
          value={user.role === "admin" ? "admin" : "customer"}
          onChange={(e) =>
            onRoleChange(user.id, e.target.value as Role)
          }
          disabled={isBusy || isCurrentUser}
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
            disabled={isBusy || isCurrentUser}
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
          disabled={isBusy || isCurrentUser}
        >
          Delete
        </button>
      </td>
    </tr>
  );
});

type OptimisticUserAction =
  | { type: "role"; userId: string; role: Role }
  | { type: "toggle-active"; user: User; isActive: boolean }
  | { type: "delete"; userId: string };

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";
  // Fetch-on-role-change: non-admins render the access-denied branch and the
  // queries stay disabled, so no admin data is fetched for them.
  const usersQuery = useAdminUsers({ enabled: isAdmin });
  const statsQuery = useAdminStatistics({ enabled: isAdmin });
  const userList = usersQuery.data ?? [];
  // Optimistic layer: role/status/delete mutations apply to the visible table
  // instantly and are dropped once the real cache update (or a failure) lands.
  const [optimisticUsers, addOptimistic] = useOptimistic(
    userList,
    (state, action: OptimisticUserAction) => {
      switch (action.type) {
        case "delete":
          return state.filter((u) => u.id !== action.userId);
        case "role":
          return state.map((u) =>
            u.id === action.userId ? { ...u, role: action.role } : u,
          );
        case "toggle-active":
          return state.map((u) =>
            u.id === action.user.id ? { ...u, is_active: action.isActive } : u,
          );
      }
    },
  );
  // addOptimistic must run inside an action (async transition) for React to
  // re-render optimistically.
  const [, startTransition] = useTransition();
  const stats = statsQuery.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const statsFailed = statsQuery.isError;
  const listError = usersQuery.isError ? (usersQuery.error as Error).message : null;
  const errorMessage = listError ?? error;

  // Handlers use functional setState only, so they are stable across renders
  // and memoized rows are not invalidated by parent re-renders. Each one
  // updates the shared users query cache instead of local component state.
  const handleRoleChange = useCallback((userId: string, role: Role) => {
    setBusyId(userId);
    setError(null);
    startTransition(async () => {
      addOptimistic({ type: "role", userId, role });
      try {
        const updated = await users.updateUserRole(userId, role);
        queryClient.setQueryData<User[]>(ADMIN_USERS_QUERY_KEY, (prev) =>
          (prev ?? []).map((u) =>
            u.id === userId ? { ...u, role: updated.role } : u,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update role");
      } finally {
        setBusyId(null);
      }
    });
  }, [queryClient]);

  const handleDelete = useCallback((userId: string, username: string) => {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;

    setBusyId(userId);
    setError(null);
    startTransition(async () => {
      addOptimistic({ type: "delete", userId });
      try {
        await users.deleteUser(userId);
        queryClient.setQueryData<User[]>(ADMIN_USERS_QUERY_KEY, (prev) =>
          (prev ?? []).filter((u) => u.id !== userId),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete user");
      } finally {
        setBusyId(null);
      }
    });
  }, [queryClient]);

  const handleToggleActive = useCallback((user: User) => {
    setBusyId(user.id);
    setError(null);
    startTransition(async () => {
      addOptimistic({
        type: "toggle-active",
        user,
        isActive: !user.is_active,
      });
      try {
        const updated = await users.updateUserActive(user.id, !user.is_active);
        queryClient.setQueryData<User[]>(ADMIN_USERS_QUERY_KEY, (prev) =>
          (prev ?? []).map((u) =>
            u.id === user.id ? { ...u, is_active: updated.is_active } : u,
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update status");
      } finally {
        setBusyId(null);
      }
    });
  }, [queryClient]);

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

      {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}

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

      {usersQuery.isPending ? (
        <SkeletonList rows={4} />
      ) : optimisticUsers.length === 0 ? (
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
              {optimisticUsers.map((user) => (
                <AdminUserRow
                  key={user.id}
                  user={user}
                  isBusy={busyId === user.id}
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