import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandingGate } from "../App";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user }),
}));

let user: { username: string; role: string } | null;

function renderGate() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Suspense fallback={<div>loading</div>}>
        <Routes>
          <Route path="/" element={<LandingGate />} />
          <Route path="/app" element={<div>app home</div>} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

describe("LandingGate", () => {
  beforeEach(() => {
    user = null;
  });

  it("renders the landing page for anonymous visitors", async () => {
    renderGate();
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Find and ask anything",
    );
  });

  it("redirects authenticated users from / to /app", async () => {
    user = { username: "alice", role: "customer" };
    renderGate();
    expect(await screen.findByText("app home")).toBeTruthy();
  });
});