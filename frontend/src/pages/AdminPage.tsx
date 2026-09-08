import { useCallback, useEffect, useState } from "react";
import { users } from "../services/api";
import type { User } from "../types";
import { useAuth } from "../hooks/useAuth";
import { SkeletonList } from "../components/Skeleton";

type Role = "customer" | "admin";

export function AdminPage() {
  const { user: currentUser } = useAuth();
  const [userList, setUserList] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    if (isAdmin) void loadUsers();
  }, [isAdmin, loadUsers]);

  async function handleRoleChange(userId: string, role: Role) {
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
  }

  async function handleDelete(userId: string, username: string) {
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
  }

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

      {isLoading ? (
        <SkeletonList rows={4} />
      ) : userList.length === 0 ? (
        <div className="empty-state">
          <p>No users found.</p>
        </div>
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
                <tr key={user.id}>
                  <td>{user.username}</td>
                  <td>
                    <select
                      value={user.role === "admin" ? "admin" : "customer"}
                      onChange={(e) =>
                        handleRoleChange(
                          user.id,
                          e.target.value as Role,
                        )
                      }
                      disabled={busyId === user.id || user.id === currentUser?.id}
                      aria-label={`Role for ${user.username}`}
                    >
                      <option value="customer">customer</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>{user.is_active ? "active" : "disabled"}</td>
                  <td>
                    {user.created_at
                      ? new Date(user.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td>
                    <button
                      onClick={() => handleDelete(user.id, user.username)}
                      className="btn btn-danger"
                      disabled={busyId === user.id || user.id === currentUser?.id}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}