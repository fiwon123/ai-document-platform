import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";

const PANEL_FEATURES = [
  "Semantic search across every file you upload",
  "Grounded answers with source context",
  "Private by design — data isolated per user",
];

/**
 * Shared two-column shell for the Login/Register pages: a brand panel on the
 * left (desktop only) and the form card on the right, with a back-to-home
 * link, the theme toggle, and a card entrance animation.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <div className="auth-theme-toggle">
        <ThemeToggle />
      </div>

      {/* The shell is the page's primary content (brand panel + form card), so it
          is the main landmark. The theme toggle and the back link above/inside it
          are controls and navigation, which must stay outside <main>. */}
      <main className="auth-shell">
        <aside className="auth-panel" aria-label="About AskDocs">
          <div className="auth-panel-brand">
            <svg
              viewBox="0 0 24 24"
              width="30"
              height="30"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M6 3h8l4 4v14H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M14 3v4h4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M9.5 12l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9.9-1.9Z"
                fill="currentColor"
              />
            </svg>
            AskDocs
          </div>

          <div>
            <h2>Your documents, answered.</h2>
            <ul className="auth-panel-features">
              {PANEL_FEATURES.map((feature) => (
                <li key={feature}>
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M20 6 9 17l-5-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
          </div>

          <p className="auth-panel-foot">
            Free to start — no credit card required.
          </p>
        </aside>

        <div className="auth-card">
          <Link to="/" className="auth-back">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M15 4l-8 8 8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to home
          </Link>

          <h1>{title}</h1>
          <p className="auth-subtitle">{subtitle}</p>

          {children}
        </div>
      </main>
    </div>
  );
}