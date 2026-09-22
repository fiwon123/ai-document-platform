import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage";
import { useAuth } from "../hooks/useAuth";
import type { User } from "../types";

const adminSelf: User = {
  id: "u-admin",
  username: "root",
  is_active: true,
  role: "admin",
  created_at: null,
};

const alice: User = {
  id: "u-1",
  username: "alice",
  is_active: true,
  role: "customer",
  created_at: "2026-09-01T00:00:00Z",
};

vi.mock("../hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    user: adminSelf,
    token: "t",
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    updateUser: vi.fn(),
  })),
}));

vi.mock("../services/api", () => ({
  users: {
    listUsers: vi.fn(),
    updateUserRole: vi.fn(),
    updateUserActive: vi.fn(),
    deleteUser: vi.fn(),
  },
}));

import { users } from "../services/api";

const mockedUseAuth = vi.mocked(useAuth);
const mockedListUsers = vi.mocked(users.listUsers);
const mockedUpdateUserRole = vi.mocked(users.updateUserRole);
const mockedUpdateUserActive = vi.mocked(users.updateUserActive);
const mockedDeleteUser = vi.mocked(users.deleteUser);

describe("AdminPage", () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: adminSelf,
      token: "t",
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      updateUser: vi.fn(),
    });
    mockedListUsers.mockResolvedValue([adminSelf, alice]);
    mockedUpdateUserRole.mockResolvedValue({ ...alice, role: "admin" });
    mockedUpdateUserActive.mockResolvedValue({ ...alice, is_active: false });
    mockedDeleteUser.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function renderPage() {
    render(<AdminPage />);
    await act(async () => {});
  }

  it("loads and lists users with role and status columns", async () => {
    await renderPage();

    expect(mockedListUsers).toHaveBeenCalled();
    expect(screen.getByText("root")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getAllByText("active").length).toBe(2);
  });

  it("updates a user role through the API", async () => {
    await renderPage();

    fireEvent.change(screen.getByLabelText("Role for alice"), {
      target: { value: "admin" },
    });

    await act(async () => {});

    expect(mockedUpdateUserRole).toHaveBeenCalledWith("u-1", "admin");
  });

  it("deletes a user after confirmation", async () => {
    await renderPage();

    const deleteButtons = screen.getAllByText("Delete") as HTMLButtonElement[];
    const aliceRow = deleteButtons.find(
      (b) => b.closest("tr")?.textContent?.includes("alice"),
    );
    expect(aliceRow).toBeTruthy();
    aliceRow?.click();

    await act(async () => {});

    expect(window.confirm).toHaveBeenCalled();
    expect(mockedDeleteUser).toHaveBeenCalledWith("u-1");
    expect(screen.queryByText("alice")).toBeNull();
  });

  it("does not let admins delete or demote themselves", async () => {
    await renderPage();

    const deleteButtons = screen.getAllByText("Delete") as HTMLButtonElement[];
    const rootRow = deleteButtons.find(
      (b) => b.closest("tr")?.textContent?.includes("root"),
    );
    expect((rootRow as HTMLButtonElement).disabled).toBe(true);

    const roleSelects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    const rootSelect = roleSelects.find((s) =>
      s.closest("tr")?.textContent?.includes("root"),
    );
    expect((rootSelect as HTMLSelectElement).disabled).toBe(true);
  });

  it("disables a user via the activation toggle", async () => {
    await renderPage();

    const toggle = screen.getByRole("button", { name: "Disable alice" });
    fireEvent.click(toggle);
    await act(async () => {});

    expect(mockedUpdateUserActive).toHaveBeenCalledWith("u-1", false);
    expect(screen.getByText("disabled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable alice" })).toBeTruthy();
  });

  it("enables a user via the activation toggle", async () => {
    mockedListUsers.mockResolvedValue([adminSelf, { ...alice, is_active: false }]);
    mockedUpdateUserActive.mockResolvedValue({ ...alice, is_active: true });
    await renderPage();

    const toggle = screen.getByRole("button", { name: "Enable alice" });
    fireEvent.click(toggle);
    await act(async () => {});

    expect(mockedUpdateUserActive).toHaveBeenCalledWith("u-1", true);
    expect(screen.getByRole("button", { name: "Disable alice" })).toBeTruthy();
  });

  it("does not let admins toggle their own active state", async () => {
    await renderPage();

    const toggle = screen.getByRole("button", { name: "Disable root" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error when toggling fails", async () => {
    mockedUpdateUserActive.mockRejectedValue(new Error("Cannot deactivate self"));
    await renderPage();

    const toggle = screen.getByRole("button", { name: "Disable alice" });
    fireEvent.click(toggle);
    await act(async () => {});

    expect(screen.getByText("Cannot deactivate self")).toBeTruthy();
  });

  it("shows an empty state when there are no users", async () => {
    mockedListUsers.mockResolvedValue([]);
    await renderPage();

    expect(screen.getByText("No users found")).toBeTruthy();
    expect(
      screen.getByText("There are no user accounts yet."),
    ).toBeTruthy();
  });

  it("shows an access-denied message for non-admin users", async () => {
    mockedUseAuth.mockReturnValue({
      user: alice,
      token: "t",
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      updateUser: vi.fn(),
    });

    render(<AdminPage />);

    expect(screen.getByText("Admin privileges required.")).toBeTruthy();
    expect(mockedListUsers).not.toHaveBeenCalled();
  });
});