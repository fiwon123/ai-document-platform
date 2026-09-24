import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./RegisterPage";

const register = vi.fn();

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ register }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function submitRegistration(
  username: string,
  password: string,
  confirmPassword: string,
) {
  renderPage();
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("Confirm Password"), {
    target: { value: confirmPassword },
  });
  fireEvent.click(screen.getByRole("button", { name: "Register" }));
  await act(async () => {});
}

describe("RegisterPage", () => {
  beforeEach(() => {
    register.mockReset();
  });

  it("renders the registration form with all fields", () => {
    renderPage();
    expect(screen.getByText("Create a new account")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm Password")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Register" }),
    ).toBeTruthy();
  });

  it("calls register with the entered credentials", async () => {
    register.mockResolvedValue(undefined);
    await submitRegistration("alice", "s3cret123", "s3cret123");
    expect(register).toHaveBeenCalledWith("alice", "s3cret123", "s3cret123");
  });

  it("navigates to the login page after a successful registration", async () => {
    register.mockResolvedValue(undefined);
    await submitRegistration("alice", "s3cret123", "s3cret123");
    expect(screen.getByText("login page")).toBeTruthy();
  });

  it("surfaces a friendly message when passwords do not match", async () => {
    register.mockResolvedValue(undefined);
    await submitRegistration("alice", "s3cret123", "different");
    expect(screen.getByText("Passwords do not match")).toBeTruthy();
  });

  it("does not call register when passwords do not match", async () => {
    register.mockResolvedValue(undefined);
    await submitRegistration("alice", "s3cret123", "different");
    expect(register).not.toHaveBeenCalled();
  });

  it("surfaces the registration error message on failure", async () => {
    register.mockRejectedValue(new Error("Username already taken"));
    await submitRegistration("alice", "s3cret123", "s3cret123");
    expect(screen.getByText("Username already taken")).toBeTruthy();
  });

  it("falls back to a generic message for non-Error failures", async () => {
    register.mockRejectedValue("raw failure object");
    await submitRegistration("alice", "s3cret123", "s3cret123");
    expect(screen.getByText("Registration failed")).toBeTruthy();
  });

  it("clears a previous error before a new submission", async () => {
    register
      .mockRejectedValueOnce(new Error("Username already taken"))
      .mockResolvedValueOnce(undefined);

    await submitRegistration("alice", "s3cret123", "s3cret123");
    expect(screen.getByText("Username already taken")).toBeTruthy();

    // Submit again with matching passwords — the error must be cleared.
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret456" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "s3cret456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    await act(async () => {});

    expect(screen.queryByText("Username already taken")).toBeNull();
    expect(screen.getByText("login page")).toBeTruthy();
  });

  it("shows a loading state and disables fields while submitting", async () => {
    let resolveRegistration: (value: unknown) => void;
    register.mockReturnValue(
      new Promise((resolve) => {
        resolveRegistration = resolve;
      }),
    );

    renderPage();
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "s3cret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    expect(screen.getByText("Creating account...")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeDisabled();
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByLabelText("Confirm Password")).toBeDisabled();

    resolveRegistration!(undefined);
    await act(async () => {});
  });

  it("respects the username format constraints", () => {
    renderPage();
    const username = screen.getByLabelText("Username");
    expect(username).toHaveAttribute("minLength", "3");
    expect(username).toHaveAttribute("maxLength", "20");
    expect(username).toHaveAttribute("pattern", "^[a-zA-Z0-9_]+$");
  });

  it("requires a password of at least 8 characters", () => {
    renderPage();
    expect(screen.getByLabelText("Password")).toHaveAttribute("minLength", "8");
  });

  it("offers a link to the login page", () => {
    renderPage();
    const loginLink = screen.getByRole("link", { name: "Login" });
    expect(loginLink.getAttribute("href")).toBe("/login");
  });
});