import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Spinner } from "./Spinner";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="loading-center">
        <Spinner size={32} label="Loading your session" />
        {/* aria-hidden: the spinner above already carries this as the accessible
            name on its role="status". Repeating it would announce it twice — the
            text here is for people who cannot see the spinner label. */}
        <p className="loading-message" aria-hidden="true">
          Loading your session…
        </p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
