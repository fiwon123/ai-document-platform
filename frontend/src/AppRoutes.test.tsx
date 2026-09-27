import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MarketingShell } from "./components/PageLayout";
import { NAV_COMPANY, NAV_LEGAL, NAV_PRODUCT } from "./content/marketing";
import { NotFoundPage } from "./pages/NotFoundPage";

/* The real MarketingShell pulls in LandingNavbar, which reads auth to decide
   whether to show the "Dashboard" link. The mirrored tree is about route shape,
   not auth, so auth is stubbed the way MarketingRoutes.test.tsx stubs it. */
vi.mock("./hooks/useAuth", () => ({
  useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }),
}));

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
 * The public catch-all, wrapped in MarketingShell exactly as App.tsx does it.
 *
 * This wrapper is the fix for #460 (a <main> landmark) and for #461 (the site
 * chrome), and it is also the easy thing to drop again: a bare page fails no
 * visual review, and nothing else in the app notices. Keeping the real shell in
 * the mirror means the tests below measure what the app actually renders.
 */
function NotFound404() {
  return (
    <MarketingShell>
      <NotFoundPage />
    </MarketingShell>
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

  // #460: both 404 paths must end up with exactly one <main>. Zero is the bug,
  // and two (the public shell nested inside the protected shell's own <main>)
  // would be the overcorrection.
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

  // #461: the 404 rendered with nav=0, footer=0 — the only public route without
  // the site chrome. Asserting a navbar merely *exists* would pass on a
  // decorative one, so this asserts what the issue actually complained about:
  // that a user who mistypes or follows a stale public URL can still reach the
  // marketing pages from the 404. Driven by the nav arrays, so a link the
  // navigation advertises but the 404 cannot reach fails here.
  it("gives the public 404 a route back to the marketing pages", () => {
    render(<AppRoutes path="/nope" />);
    expect(screen.getByLabelText("AskDocs home")).toBeTruthy();
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    for (const { label, to } of [
      ...NAV_PRODUCT,
      ...NAV_COMPANY,
      ...NAV_LEGAL,
    ]) {
      expect(hrefs, `the 404 should link to ${to} (${label})`).toContain(to);
    }
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