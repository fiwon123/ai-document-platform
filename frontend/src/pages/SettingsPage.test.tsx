import { act, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { renderWithClient } from "../test/renderWithClient";
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

/** Mirrors the backend's registry: free tier and paid tier kept separate. */
const MODELS = {
  free: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  paid: ["gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-turbo"],
};

const MODEL_STORAGE_KEY = "askdocs-model";
const API_KEY_STORAGE_KEY = "askdocs-api-key";

function renderPage() {
  return renderWithClient(
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

  it("renders an icon next to each settings section heading", async () => {
    renderPage();
    await act(async () => {});

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.length).toBeGreaterThanOrEqual(3);
    headings.forEach((h) => {
      expect(h.querySelector("svg")).toBeTruthy();
    });
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

  it("defaults to the first free model when nothing is saved", async () => {
    renderPage();
    await act(async () => {});

    // The default is `models.free[0]`, so assert the grouping rather than
    // hardcoding an id: this test failed when the free list was reclassified
    // and the checked radio moved out from under a hardcoded name.
    const freeGroup = screen.getByText("Free models").parentElement;
    const firstFree = freeGroup?.querySelector<HTMLInputElement>(
      "input[type=radio]",
    );
    const paidGroup = screen.getByText("Paid models").parentElement;
    const anyPaid = paidGroup?.querySelector<HTMLInputElement>(
      "input[type=radio]",
    );

    expect(firstFree?.checked).toBe(true);
    expect(anyPaid?.checked).toBe(false);
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

  it("does not offer a paid model under the free heading when offline (#486)", async () => {
    // The fallback list is the one the user sees when /v1/qa/models is
    // unreachable. It used to file gpt-4o-mini as "free", which the backend
    // reclassifies as paid because it bills per token — so the offline path
    // offered the single most expensive option as the free default.
    mockedGetModels.mockRejectedValue(new Error("network down"));
    renderPage();
    await act(async () => {});

    const freeGroup = screen.getByText("Free models").parentElement;
    const paidGroup = screen.getByText("Paid models").parentElement;

    const freeIds = Array.from(
      freeGroup?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [],
    ).map((i) => i.value);
    const paidIds = Array.from(
      paidGroup?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [],
    ).map((i) => i.value);

    expect(freeIds.length).toBeGreaterThan(0);
    expect(paidIds.length).toBeGreaterThan(0);
    expect(freeIds).not.toContain("gpt-4o-mini");
    expect(paidIds).toContain("gpt-4o-mini");
    // A model cannot be in both groups: it would appear twice on the page.
    expect(freeIds.filter((id) => paidIds.includes(id))).toEqual([]);
  });
});