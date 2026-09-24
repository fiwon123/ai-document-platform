import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./hooks/AuthProvider";
import { ToastProvider } from "./context/ToastProvider";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Navbar } from "./components/Navbar";
import { queryClient } from "./lib/queryClient";
import "./App.css";

// Route pages are code-split so each loads on demand.
const LandingPage = lazy(() =>
  import("./pages/LandingPage").then((m) => ({ default: m.LandingPage })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const RegisterPage = lazy(() =>
  import("./pages/RegisterPage").then((m) => ({ default: m.RegisterPage })),
);
const DemoPage = lazy(() =>
  import("./pages/DemoPage").then((m) => ({ default: m.DemoPage })),
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
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const WebhooksPage = lazy(() =>
  import("./pages/WebhooksPage").then((m) => ({ default: m.WebhooksPage })),
);
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);

const pageFallback = <div className="loading">Loading page…</div>;

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={pageFallback}>
            <ErrorBoundary label="Application error">
              <ToastProvider>
                <div className="app">
                  <Routes>
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/register" element={<RegisterPage />} />
                    <Route path="/demo" element={<DemoPage />} />
                    <Route
                      path="/app/*"
                      element={
                        <ProtectedRoute>
                          <Navbar />
                          <main className="main-content">
                            <ErrorBoundary label="Page error">
                              <Routes>
                                <Route path="" element={<DashboardPage />} />
                                <Route path="documents" element={<DocumentsPage />} />
                                <Route path="search" element={<SearchPage />} />
                                <Route path="qa" element={<QAPage />} />
                                <Route path="settings" element={<SettingsPage />} />
                                <Route path="webhooks" element={<WebhooksPage />} />
                                <Route path="profile" element={<ProfilePage />} />
                                <Route path="admin" element={<AdminPage />} />
                                <Route path="*" element={<NotFoundPage />} />
                              </Routes>
                            </ErrorBoundary>
                          </main>
                        </ProtectedRoute>
                      }
                    />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </div>
              </ToastProvider>
            </ErrorBoundary>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
