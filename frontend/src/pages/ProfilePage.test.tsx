import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePage } from "./ProfilePage";
import { renderWithClient } from "../test/renderWithClient";
import type { User } from "../types";

const alice: User = {
  id: "u-1",
  username: "alice",
  is_active: true,
  role: "customer",
  created_at: null,
};

const updateUser = vi.fn();

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: alice,
    updateUser,
  }),
}));

vi.mock("../services/api", () => ({
  users: { updateMe: vi.fn() },
}));

import { users } from "../services/api";

const mockedUpdateMe = vi.mocked(users.updateMe);

describe("ProfilePage", () => {
  beforeEach(() => {
    mockedUpdateMe.mockResolvedValue({ ...alice, username: "alice_new" });
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

  it("saves a new username and updates the auth context", async () => {
    renderWithClient(<ProfilePage />);

    const usernameInput = screen.getByLabelText("Username");
    fireEvent.change(usernameInput, { target: { value: "alice_new" } });

    fireEvent.click(screen.getByText("Save changes"));

    await act(async () => {});

    expect(mockedUpdateMe).toHaveBeenCalledWith({
      username: "alice_new",
      password: undefined,
      confirmPassword: undefined,
    });
    expect(updateUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice_new" }),
    );
    expect(screen.getByText("Profile updated")).toBeTruthy();
  });

  it("warns when the new password fields do not match", async () => {
    renderWithClient(<ProfilePage />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });

    fireEvent.click(screen.getByText("Save changes"));

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
});