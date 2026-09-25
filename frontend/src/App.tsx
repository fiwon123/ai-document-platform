import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  type Location,
} from "react-router-dom";
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
/* Marketing pages. Each is its own chunk so the landing page's first paint does
   not carry a dozen pages of legal prose it will never render. */
const ProductPage = lazy(() =>
  import("./pages/ProductPage").then((m) => ({ default: m.ProductPage })),
);
const FeaturesPage = lazy(() =>
  import("./pages/FeaturesPage").then((m) => ({ default: m.FeaturesPage })),
);
const HowItWorksPage = lazy(() =>
  import("./pages/HowItWorksPage").then((m) => ({ default: m.HowItWorksPage })),
);
const PricingPage = lazy(() =>
  import("./pages/PricingPage").then((m) => ({ default: m.PricingPage })),
);
const CompanyPage = lazy(() =>
  import("./pages/CompanyPage").then((m) => ({ default: m.CompanyPage })),
);
const AboutPage = lazy(() =>
  import("./pages/AboutPage").then((m) => ({ default: m.AboutPage })),
);
const BlogPage = lazy(() =>
  import("./pages/BlogPage").then((m) => ({ default: m.BlogPage })),
);
const CareersPage = lazy(() =>
  import("./pages/CareersPage").then((m) => ({ default: m.CareersPage })),
);
const ContactPage = lazy(() =>
  import("./pages/ContactPage").then((m) => ({ default: m.ContactPage })),
);
const PrivacyPage = lazy(() =>
  import("./pages/PrivacyPage").then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() =>
  import("./pages/TermsPage").then((m) => ({ default: m.TermsPage })),
);
const SecurityPage = lazy(() =>
  import("./pages/SecurityPage").then((m) => ({ default: m.SecurityPage })),
);
const GdprPage = lazy(() =>
  import("./pages/GdprPage").then((m) => ({ default: m.GdprPage })),
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

/* ---------------------------------------------------------------------------
   View transitions
   The route tree renders against a *stored* location so navigation can run
   through the View Transition API: React renders the new page inside
   document.startViewTransition() (flushed synchronously) and the browser
   cross-fades the outgoing/incoming snapshots. Without API support the
   location updates immediately — the app behaves exactly as before.
   --------------------------------------------------------------------------- */

type ViewTransitionLike = { finished: Promise<void> };

function getViewTransitionStart():
  | ((update: () => void) => ViewTransitionLike)
  | null {
  const doc = document as unknown as {
    startViewTransition?: (update: () => void) => ViewTransitionLike;
  };
  return typeof doc.startViewTransition === "function"
    ? doc.startViewTransition.bind(doc)
    : null;
}

/** The location the route tree currently renders for (see above). */
const DisplayLocationContext = createContext<Location | null>(null);

function ViewTransitionRoutes({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [displayLocation, setDisplayLocation] = useState(location);

  // Adjust state during render (the documented derived-state pattern): any
  // key mismatch means the user navigated. With the View Transition API we
  // render the new page inside the transition callback via flushSync so the
  // browser captures both snapshots; without it, update immediately.
  if (location.key !== displayLocation.key) {
    const start = getViewTransitionStart();
    if (start) {
      const next = location;
      try {
        const transition = start(() => {
          flushSync(() => setDisplayLocation(next));
        });
        // A navigation racing this one aborts the previous transition; the
        // render callback already ran, so swallow the rejection.
        transition.finished.catch(() => {});
      } catch {
        setDisplayLocation(location);
      }
    } else {
      setDisplayLocation(location);
    }
  }

  return (
    <DisplayLocationContext.Provider value={displayLocation}>
      <Routes location={displayLocation}>{children}</Routes>
    </DisplayLocationContext.Provider>
  );
}

/** The protected app shell renders its relative routes against the same
 * stored location so the whole page cross-fades together on navigation. */
function ProtectedRoutes() {
  const displayLocation = useContext(DisplayLocationContext);
  return (
    <ProtectedRoute>
      <Navbar />
      <main className="main-content">
        <ErrorBoundary label="Page error">
          <Routes location={displayLocation ?? undefined}>
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
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={pageFallback}>
            <ErrorBoundary label="Application error">
              <ToastProvider>
                <div className="app">
                  <ViewTransitionRoutes>
                    <Route path="/" element={<LandingPage />} />
                    {/* Product */}
                    <Route path="/product" element={<ProductPage />} />
                    <Route path="/features" element={<FeaturesPage />} />
                    <Route path="/how-it-works" element={<HowItWorksPage />} />
                    <Route path="/pricing" element={<PricingPage />} />
                    <Route path="/demo" element={<DemoPage />} />
                    {/* Company */}
                    <Route path="/company" element={<CompanyPage />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/blog" element={<BlogPage />} />
                    <Route path="/careers" element={<CareersPage />} />
                    <Route path="/contact" element={<ContactPage />} />
                    {/* Legal */}
                    <Route path="/privacy" element={<PrivacyPage />} />
                    <Route path="/terms" element={<TermsPage />} />
                    <Route path="/security" element={<SecurityPage />} />
                    <Route path="/gdpr" element={<GdprPage />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/register" element={<RegisterPage />} />
                    <Route path="/demo" element={<DemoPage />} />
                    <Route path="/app/*" element={<ProtectedRoutes />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </ViewTransitionRoutes>
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
