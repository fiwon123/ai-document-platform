import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterPage, TERMS_ERROR } from "./RegisterPage";

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

async function submitRegistration(username: string, password: string, confirmPassword: string) {
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
  fireEvent.click(screen.getByLabelText(/I agree/));
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
    expect(screen.getByRole("button", { name: "Register" })).toBeTruthy();
    expect(screen.getByLabelText(/I agree/)).toBeTruthy();
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
    // (The terms box is still checked from the first submission.)
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
    fireEvent.click(screen.getByLabelText(/I agree/));
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

  it("offers a back-to-home link", () => {
    renderPage();
    const backLink = screen.getByRole("link", { name: "Back to home" });
    expect(backLink.getAttribute("href")).toBe("/");
  });

  it("reveals and hides the password with the visibility toggle", async () => {
    renderPage();
    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show Password" }));
    expect(passwordInput).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("shows the strength meter and checklist while typing a password", () => {
    renderPage();
    expect(screen.queryByRole("meter")).toBeNull();

    // "Ab" — mixed case only: 1 of 4 segments (25%).
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Ab" },
    });
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("At least 8 characters")).toBeTruthy();
    expect(screen.getByText("Upper & lower case letters")).toBeTruthy();
    expect(screen.getByText("At least one number")).toBeTruthy();
    expect(meter.querySelectorAll(".strength-seg.lit")).toHaveLength(1);

    // "Abcdef12" — length + mixed + digit: 3 of 4 segments (75%).
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Abcdef12" },
    });
    expect(meter).toHaveAttribute("aria-valuenow", "75");
    expect(meter.querySelectorAll(".strength-seg.lit")).toHaveLength(3);
  });

  it("shows a live password match indicator", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "abcd1234" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "abcd9999" },
    });
    const indicator = screen.getByText("Passwords don't match");
    expect(indicator.className).toContain("match-bad");

    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "abcd1234" },
    });
    expect(screen.getByText("Passwords match").className).toContain("match-ok");
  });

  it("blocks submission until the terms checkbox is accepted", async () => {
    register.mockResolvedValue(undefined);
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
    await act(async () => {});

    expect(register).not.toHaveBeenCalled();
    expect(screen.getByText(TERMS_ERROR)).toBeTruthy();
  });
});
