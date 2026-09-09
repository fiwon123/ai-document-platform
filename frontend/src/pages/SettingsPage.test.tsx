import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import type { User } from "../types";

const alice: User = {
  id: "u-1",
  username: "alice",
  is_active: true,
  role: "customer",
  created_at: null,
};

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: alice }),
}));

vi.mock("../services/api", () => ({
  qa: { getModels: vi.fn() },
}));

import { qa } from "../services/api";

const mockedGetModels = vi.mocked(qa.getModels);

const MODELS = {
  free: ["gpt-4o-mini"],
  paid: ["gpt-4o", "gpt-4", "gpt-4-turbo"],
};

const MODEL_STORAGE_KEY = "askdocs-model";
const API_KEY_STORAGE_KEY = "askdocs-api-key";

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    mockedGetModels.mockResolvedValue(MODELS);
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the current username and a link to the profile page", async () => {
    renderPage();
    await act(async () => {});

    expect(screen.getByText("alice")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Edit profile" }).getAttribute("href"),
    ).toBe("/app/profile");
  });

  it("shows the model picker grouped by free and paid tiers", async () => {
    renderPage();
    await act(async () => {});

    expect(screen.getByText("Free models")).toBeTruthy();
    expect(screen.getByText("Paid models")).toBeTruthy();
    expect(screen.getByLabelText("gpt-4o-mini")).toBeTruthy();
    expect(screen.getByLabelText("gpt-4o")).toBeTruthy();
    expect(screen.getByLabelText("gpt-4-turbo")).toBeTruthy();
  });

  it("defaults to the free model when nothing is saved", async () => {
    renderPage();
    await act(async () => {});

    expect(
      (screen.getByLabelText("gpt-4o-mini") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("reflects a previously saved model selection on load", async () => {
    localStorage.setItem(MODEL_STORAGE_KEY, "gpt-4");
    renderPage();
    await act(async () => {});

    expect((screen.getByLabelText("gpt-4") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("persists the selected model to localStorage on change", async () => {
    renderPage();
    await act(async () => {});

    const paidRadio = screen.getByLabelText("gpt-4o") as HTMLInputElement;
    fireEvent.click(paidRadio);

    expect(localStorage.getItem(MODEL_STORAGE_KEY)).toBe("gpt-4o");
    expect(paidRadio.checked).toBe(true);
  });

  it("saves the custom API key to localStorage and clears it", async () => {
    renderPage();
    await act(async () => {});

    const input = screen.getByLabelText("Custom API key");
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByText("Save"));

    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-test-123");
    expect(screen.getByText("API key saved")).toBeTruthy();

    fireEvent.click(screen.getByText("Clear"));

    expect(localStorage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
    expect(screen.getByText("API key cleared")).toBeTruthy();
  });

  it("falls back to default models when fetching models fails", async () => {
    mockedGetModels.mockRejectedValue(new Error("network down"));
    renderPage();
    await act(async () => {});

    expect(screen.getByLabelText("gpt-4o-mini")).toBeTruthy();
    expect(screen.getByLabelText("gpt-4o")).toBeTruthy();
    expect(screen.getByLabelText("gpt-4-turbo")).toBeTruthy();
  });
});