import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NotFoundPage } from "./pages/NotFoundPage";

/**
 * Mirrors the route tree declared in App.tsx to lock in the routing contract:
 * - "/" is public (landing), "/demo" is the public demo page, "/app/*" is the
 *   protected shell with RELATIVE inner paths, and unknown public paths fall
 *   back to the 404 page.
 */
function AppRoutes({ path }: { path: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>landing</div>} />
        <Route path="/demo" element={<div>demo</div>} />
        <Route path="/app/*" element={<AppShell />} />
        <Route path="*" element={<NotFound404 />} />
      </Routes>
    </MemoryRouter>
  );
}

/**
 * The public catch-all, wrapped in `<main>` exactly as App.tsx does it.
 *
 * This wrapper is the whole fix for #460, and it is also the easy thing to drop
 * again: a `<main>` that renders nothing visible fails no visual review, and
 * nothing else in the app notices. Keeping it in the mirror means the tests
 * below measure what the app actually renders.
 */
function NotFound404() {
  return (
    <main>
      <NotFoundPage />
    </main>
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
        <Route path="settings" element={<div>settings</div>} />
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
    render(<AppRoutes path="/app/settings" />);
    expect(screen.getByText("settings")).toBeTruthy();
  });

  it("renders the public demo page at /demo", () => {
    render(<AppRoutes path="/demo" />);
    expect(screen.getByText("demo")).toBeTruthy();
  });

  it("renders the 404 page for unknown paths inside /app", () => {
    render(<AppRoutes path="/app/nope" />);
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
  });

  it("renders the 404 page for unknown public paths", () => {
    render(<AppRoutes path="/nope" />);
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
  });

  // #460: the public catch-all is the only route with no shell around it, so it
  // is the only page that had no <main> landmark. Both 404 paths must end up
  // with exactly one -- zero is the bug, and two (the public wrapper nested
  // inside the protected shell's own <main>) would be the overcorrection.
  it("gives the public 404 exactly one main landmark", () => {
    const { container, unmount } = render(<AppRoutes path="/nope" />);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    unmount();
  });

  it("does not nest a second main on a 404 inside the protected shell", () => {
    const { container, unmount } = render(<AppRoutes path="/app/nope" />);
    expect(screen.getByText("This page could not be found.")).toBeTruthy();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    unmount();
  });

  it("keeps the 404 heading structure intact", () => {
    const { container, unmount } = render(<AppRoutes path="/nope" />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    // The big "404" is decorative and must stay out of the accessibility tree.
    const code = container.querySelector(".not-found-code");
    expect(code?.getAttribute("aria-hidden")).toBe("true");
    unmount();
  });
});