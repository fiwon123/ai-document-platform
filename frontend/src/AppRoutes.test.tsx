import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NotFoundPage } from "./pages/NotFoundPage";

/**
 * Mirrors the route tree declared in App.tsx to lock in the routing contract:
 * - "/" is public (landing), "/app/*" is the protected shell with RELATIVE
 *   inner paths, and unknown public paths fall back to the 404 page.
 */
function AppRoutes({ path }: { path: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>landing</div>} />
        <Route path="/app/*" element={<AppShell />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function AppShell() {
  return (
    <main>
      <Routes>
        <Route path="" element={<div>dashboard</div>} />
        <Route path="documents" element={<div>documents</div>} />
        <Route path="search" element={<div>search</div>} />
        <Route path="qa" element={<div>qa</div>} />
        <Route path="profile" element={<div>profile</div>} />
        <Route path="admin" element={<div>admin</div>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </main>
  );
}

describe("app route tree", () => {
  it("matches the /app index to the dashboard", () => {
    render(<AppRoutes path="/app" />);
    expect(screen.getByText("dashboard")).toBeTruthy();
  });

  it("matches relative inner paths under /app", () => {
    render(<AppRoutes path="/app/documents" />);
    expect(screen.getByText("documents")).toBeTruthy();
    render(<AppRoutes path="/app/search" />);
    expect(screen.getByText("search")).toBeTruthy();
  });

  it("renders the 404 page for unknown paths inside /app", () => {
    render(<AppRoutes path="/app/nope" />);
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
  });

  it("renders the 404 page for unknown public paths", () => {
    render(<AppRoutes path="/nope" />);
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
  });
});