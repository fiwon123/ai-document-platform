import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage, REMEMBER_KEY } from "./LoginPage";

const login = vi.fn();
const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ login }),
}));

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({
    info: toastInfo,
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

async function submitLogin(username: string, password: string) {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/app" element={<div>app area</div>} />
      </Routes>
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
    toastInfo.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("calls login with the entered credentials", async () => {
    login.mockResolvedValue(undefined);
    await submitLogin("alice", "s3cret");
    expect(login).toHaveBeenCalledWith("alice", "s3cret");
  });

  it("navigates to the /app area after a successful login", async () => {
    login.mockResolvedValue(undefined);
    await submitLogin("alice", "s3cret");
    expect(screen.getByText("app area")).toBeTruthy();
  });

  it("surfaces a friendly message when login fails", async () => {
    login.mockRejectedValue(new Error("Invalid credentials"));
    await submitLogin("alice", "wrong");
    expect(screen.getByText("Invalid credentials")).toBeTruthy();
  });

  it("offers a back-to-home link", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const backLink = screen.getByRole("link", { name: "Back to home" });
    expect(backLink.getAttribute("href")).toBe("/");
  });

  it("reveals and hides the password with the visibility toggle", async () => {
    login.mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show Password" }));
    expect(passwordInput).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("pre-fills the remembered username and keeps it on login", async () => {
    login.mockResolvedValue(undefined);
    localStorage.setItem(REMEMBER_KEY, "alice");

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app" element={<div>app area</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Username")).toHaveValue("alice");
    expect(screen.getByLabelText("Remember me")).toBeChecked();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByText("Sign In"));
    await act(async () => {});

    expect(login).toHaveBeenCalledWith("alice", "s3cret");
    expect(localStorage.getItem(REMEMBER_KEY)).toBe("alice");
  });

  it("stores the username when remember me is checked", async () => {
    login.mockResolvedValue(undefined);
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app" element={<div>app area</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "bob" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByLabelText("Remember me"));
    fireEvent.click(screen.getByText("Sign In"));
    await act(async () => {});

    expect(localStorage.getItem(REMEMBER_KEY)).toBe("bob");
  });

  it("removes the remembered username when remember me is unchecked", async () => {
    login.mockResolvedValue(undefined);
    localStorage.setItem(REMEMBER_KEY, "bob");

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app" element={<div>app area</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "bob" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByLabelText("Remember me")); // uncheck
    fireEvent.click(screen.getByText("Sign In"));
    await act(async () => {});

    expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
  });

  it("shows a coming-soon toast for the forgot password link", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("coming soon"),
    );
  });

  it("shows a coming-soon toast for social sign-in buttons", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Google" }));
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(toastInfo).toHaveBeenCalledTimes(2);
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("coming soon"),
    );
  });
});