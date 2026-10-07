import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedRoute } from "./ProtectedRoute";
import { useAuth } from "../hooks/useAuth";

vi.mock("../hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

const mockedUseAuth = vi.mocked(useAuth);

function renderUnderRouter() {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <div>protected content</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProtectedRoute", () => {
  it("renders children when a user is signed in", () => {
    mockedUseAuth.mockReturnValue({ user: { id: "u1" }, isLoading: false } as never);
    renderUnderRouter();
    expect(screen.getByText("protected content")).toBeTruthy();
  });

  it("redirects to /login when the user is signed out", () => {
    mockedUseAuth.mockReturnValue({ user: null, isLoading: false } as never);
    renderUnderRouter();
    expect(screen.getByText("login page")).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("shows a session spinner while auth is loading", () => {
    mockedUseAuth.mockReturnValue({ user: null, isLoading: true } as never);
    renderUnderRouter();
    expect(screen.getByLabelText("Loading your session")).toBeTruthy();
    expect(screen.queryByText("protected content")).toBeNull();
    expect(screen.queryByText("login page")).toBeNull();
  });
});
