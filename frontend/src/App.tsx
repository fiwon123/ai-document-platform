import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Navbar } from "./components/Navbar";
import "./App.css";

// Route pages are code-split so each loads on demand.
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const RegisterPage = lazy(() =>
  import("./pages/RegisterPage").then((m) => ({ default: m.RegisterPage })),
);
const DocumentsPage = lazy(() =>
  import("./pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const ProfilePage = lazy(() =>
  import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })),
);
const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const SearchPage = lazy(() =>
  import("./pages/SearchPage").then((m) => ({ default: m.SearchPage })),
);
const QAPage = lazy(() =>
  import("./pages/QAPage").then((m) => ({ default: m.QAPage })),
);

const pageFallback = <div className="loading">Loading page…</div>;

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={pageFallback}>
          <div className="app">
            <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <Navbar />
                  <main className="main-content">
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/documents" element={<DocumentsPage />} />
                      <Route path="/search" element={<SearchPage />} />
                      <Route path="/qa" element={<QAPage />} />
                      <Route path="/profile" element={<ProfilePage />} />
                      <Route path="/admin" element={<AdminPage />} />
                    </Routes>
                  </main>
                </ProtectedRoute>
              }
            />
          </Routes>
        </div>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
