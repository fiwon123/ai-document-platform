import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const login = vi.fn();

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ login }),
}));

async function submitLogin(username: string, password: string) {
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByText("Sign In"));
  await act(async () => {});
}

describe("LoginPage", () => {
  beforeEach(() => {
    login.mockReset();
  });

  it("calls login with the entered credentials", async () => {
    login.mockResolvedValue(undefined);
    await submitLogin("alice", "s3cret");
    expect(login).toHaveBeenCalledWith("alice", "s3cret");
  });

  it("surfaces a friendly message when login fails", async () => {
    login.mockRejectedValue(new Error("Invalid credentials"));
    await submitLogin("alice", "wrong");
    expect(screen.getByText("Invalid credentials")).toBeTruthy();
  });
});