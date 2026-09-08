import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Navbar } from "./components/Navbar";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SearchPage } from "./pages/SearchPage";
import { QAPage } from "./pages/QAPage";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
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
                    </Routes>
                  </main>
                </ProtectedRoute>
              }
            />
          </Routes>
        </div>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
