import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./ProfilePage";
import { renderWithClient } from "../test/renderWithClient";
import type { StatisticsResponse, User } from "../types";

const alice: User = {
  id: "u-1",
  username: "alice",
  is_active: true,
  role: "customer",
  created_at: "2026-09-08T00:00:00Z",
};

const meStats: StatisticsResponse = {
  total_documents: 12,
  pending_documents: 1,
  processing_documents: 0,
  ready_documents: 10,
  failed_documents: 1,
  total_chunks: 340,
  recent_documents: [],
};

const navigate = vi.fn();
const updateUser = vi.fn();
const deleteAccount = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: alice,
    updateUser,
    deleteAccount,
  }),
}));

vi.mock("../services/api", () => ({
  users: { updateMe: vi.fn(), deleteMe: vi.fn() },
  statistics: { getMe: vi.fn() },
}));

import { users, statistics } from "../services/api";

const mockedUpdateMe = vi.mocked(users.updateMe);
const mockedDeleteMe = vi.mocked(users.deleteMe);
const mockedGetMe = vi.mocked(statistics.getMe);

describe("ProfilePage", () => {
  beforeEach(() => {
    mockedUpdateMe.mockResolvedValue({ ...alice, username: "alice_new" });
    mockedDeleteMe.mockResolvedValue(undefined);
    mockedGetMe.mockResolvedValue(meStats);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pre-fills the username from the current user", () => {
    renderWithClient(<ProfilePage />);
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe(
      "alice",
    );
  });

  it("shows a profile hero with initials, role badge, and member-since date", () => {
    renderWithClient(<ProfilePage />);

    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "alice" })).toBeTruthy();
    expect(screen.getByText("customer")).toBeTruthy();
    const joined = new Date(alice.created_at as string).toLocaleDateString(
      undefined,
      { year: "numeric", month: "long" },
    );
    expect(screen.getByText(`Member since ${joined}`)).toBeTruthy();
  });

  it("shows account stats from /statistics/me", async () => {
    renderWithClient(<ProfilePage />);
    await act(async () => {});

    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
    expect(screen.getByText("Documents")).toBeTruthy();
    expect(screen.getByText("Chunks")).toBeTruthy();
  });

  it("saves a new username and updates the auth context", async () => {
    renderWithClient(<ProfilePage />);

    const usernameInput = screen.getByLabelText("Username");
    fireEvent.change(usernameInput, { target: { value: "alice_new" } });

    fireEvent.click(screen.getByText("Save changes"));

    await act(async () => {});

    expect(mockedUpdateMe).toHaveBeenCalledWith({ username: "alice_new" });
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice_new" }),
    );
    expect(screen.getByText("Profile updated")).toBeTruthy();
  });

  it("updates the password from the security card", async () => {
    renderWithClient(<ProfilePage />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "new-password-123" },
    });

    fireEvent.click(screen.getByText("Update password"));

    await act(async () => {});

    expect(mockedUpdateMe).toHaveBeenCalledWith({
      password: "new-password-123",
      confirmPassword: "new-password-123",
    });
    expect(screen.getByText("Password updated")).toBeTruthy();
  });

  it("warns when the new password fields do not match", async () => {
    renderWithClient(<ProfilePage />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });

    fireEvent.click(screen.getByText("Update password"));

    await act(async () => {});

    expect(screen.getByText("Passwords do not match")).toBeTruthy();
    expect(mockedUpdateMe).not.toHaveBeenCalled();
  });

  it("shows an error message when the update fails", async () => {
    mockedUpdateMe.mockRejectedValue(new Error("Username already registered"));

    renderWithClient(<ProfilePage />);

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "bob" },
    });

    fireEvent.click(screen.getByText("Save changes"));

    await act(async () => {});

    expect(screen.getByText("Username already registered")).toBeTruthy();
  });

  it("requires confirmation before deleting the account", async () => {
    renderWithClient(<ProfilePage />);

    // Cancel restores the original state without calling the API.
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockedDeleteMe).not.toHaveBeenCalled();

    // Confirming deletes the account, clears auth, and lands on the landing
    // page.
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Yes, permanently delete my account",
      }),
    );

    await act(async () => {});

    expect(mockedDeleteMe).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("keeps the session when account deletion fails", async () => {
    mockedDeleteMe.mockRejectedValue(new Error("Delete failed"));

    renderWithClient(<ProfilePage />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Yes, permanently delete my account",
      }),
    );

    await act(async () => {});

    expect(screen.getByText("Delete failed")).toBeTruthy();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});