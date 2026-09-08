import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <Link to="/">AD</Link>
      </div>
      <div className="navbar-links">
        <Link to="/">Dashboard</Link>
        <Link to="/documents">Documents</Link>
        <Link to="/search">Search</Link>
        <Link to="/qa">Q&A</Link>
        {user?.role === "admin" && <Link to="/admin">Users</Link>}
      </div>
      <div className="navbar-user">
        {user && (
          <>
            <Link to="/profile" className="navbar-username">
              {user.username}
            </Link>
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
