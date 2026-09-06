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
        <Link to="/">Documents</Link>
        <Link to="/search">Search</Link>
        <Link to="/qa">Q&A</Link>
      </div>
      <div className="navbar-user">
        {user && (
          <>
            <span>{user.username}</span>
            <button onClick={handleLogout} className="btn btn-secondary">
              Logout
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
