import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  // The page now imports the key name from here rather than redeclaring it,
  // so the mock has to carry the real value (#522).
  API_KEY_STORAGE_KEY: "askdocs-api-key",
}));

import { qa, API_KEY_STORAGE_KEY } from "../services/api";

const mockedGetModels = vi.mocked(qa.getModels);

/** Mirrors the backend's registry: free tier and paid tier kept separate. */
const MODELS = {
  free: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  paid: ["gpt-4o-mini", "gpt-4o", "gpt-4", "gpt-4-turbo"],
};

const MODEL_STORAGE_KEY = "askdocs-model";
// API_KEY_STORAGE_KEY is imported from ../services/api (see the mock above).

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

    /* By role+name, not `getByLabelText`: the selected option carries a check
       glyph inside its <label>, so the label's *text* reads "gpt-4 ✓". The
       glyph is `aria-hidden`, so the accessible name is still exactly "gpt-4" —
       which is what `name` resolves through, and what a screen reader gets.
       Using the text matcher here would assert something the browser never
       exposes. */
    expect(
      (screen.getByRole("radio", { name: "gpt-4" }) as HTMLInputElement).checked,
    ).toBe(true);
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
  it("centres the page in the shared workspace column (#588)", () => {
    renderPage();
    expect(document.querySelector(".page.page-column")).not.toBeNull();
  });

  it("marks the selected model with more than a colour change (#588)", async () => {
    /* A selected state conveyed only by a background or border colour is not
       one: it fails anyone who cannot separate the two hues, and the radio's
       own dot is small and sits at the far left of the row. */
    /* A model that exists in the mocked registry — the page's fallback default
       is not one of these, so without this nothing would be selected at all. */
    const [chosen] = MODELS.free;
    const [other] = MODELS.paid;
    if (!chosen || !other) throw new Error("fixture needs one free and one paid model");
    localStorage.setItem(MODEL_STORAGE_KEY, chosen);
    mockedGetModels.mockResolvedValue(MODELS);
    renderPage();
    await act(async () => {});

    const checks = document.querySelectorAll(".settings-model-option-check");
    expect(checks).toHaveLength(1);
    expect(
      screen.getByRole("radio", { name: chosen }).closest("label")
        ?.querySelector(".settings-model-option-check"),
    ).not.toBeNull();
    /* Decorative — the radio already reports `checked` itself. */
    expect(checks[0]?.getAttribute("aria-hidden")).toBe("true");

    /* The accessible name carries no glyph, so a screen reader announces the
       model and nothing else. Asserted rather than assumed — this is the whole
       reason the glyph is `aria-hidden`. */
    expect(
      screen.getByRole("radio", { name: other }),
    ).toBeInTheDocument();

    // Selecting a different model moves the mark rather than adding one.
    fireEvent.click(screen.getByRole("radio", { name: other }));
    await act(async () => {});
    expect(document.querySelectorAll(".settings-model-option-check")).toHaveLength(1);
    expect(
      screen.getByRole("radio", { name: other }).closest("label")
        ?.querySelector(".settings-model-option-check"),
    ).not.toBeNull();
  });

  it("says which of empty, saved and unsaved the API key field is in (#588)", async () => {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    renderPage();
    await act(async () => {});

    // Empty: no key stored and nothing typed.
    expect(screen.getByText("No custom API key saved.")).toBeInTheDocument();

    // A draft outranks the stored key — this is the state where "saved" would
    // be true and misleading at the same time.
    const input = screen.getByLabelText("Custom API key");
    fireEvent.change(input, { target: { value: "sk-typed-but-unsaved" } });
    await act(async () => {});
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();

    // Saving settles it, and empties the field.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(screen.getByText("A custom API key is saved.")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("");

    // Typing over a saved key says so again, rather than still reading "saved".
    fireEvent.change(input, { target: { value: "sk-something-else" } });
    await act(async () => {});
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  });

  it("does not keep claiming a saved key after storage is cleared underneath it (#588)", async () => {
    /* The state was a boolean mirror of storage, written only by the Save/Clear
       handlers. Storage can change without them — another tab, or
       `clearPersistedSession()` on logout while this page stays mounted — and
       the note then contradicted reality: "a key is saved" after the session had
       already wiped it. Storage is now the only source of truth. */
    localStorage.setItem(API_KEY_STORAGE_KEY, "sk-stored");
    const { unmount } = renderPage();
    await act(async () => {});
    expect(screen.getByText("A custom API key is saved.")).toBeInTheDocument();

    localStorage.removeItem(API_KEY_STORAGE_KEY);
    unmount();
    renderPage();
    await act(async () => {});
    expect(screen.getByText("No custom API key saved.")).toBeInTheDocument();

    /* Clear follows the same single source of truth rather than the stale flag. */
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("does not let the browser autocorrect an API key (#588)", () => {
    renderPage();
    const input = screen.getByLabelText("Custom API key") as HTMLInputElement;
    /* A key is not prose: a capitalised or "corrected" key fails at the
       provider with an error that points nowhere near the cause. */
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.getAttribute("autocapitalize")).toBe("off");
    expect(input.getAttribute("autocorrect")).toBe("off");
    /* #416 — the association and autocomplete must survive. */
    expect(input.getAttribute("id")).toBe("settings-api-key");
    expect(input.getAttribute("name")).toBe("settings-api-key");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("type")).toBe("password");
  });
});

/**
 * The model picker's selected and focus states (#588).
 *
 * Asserted in the stylesheet as well as the markup, because the acceptance
 * criterion is about how the state is *conveyed*. The check glyph alone would
 * satisfy a test that only counted elements, while a page that conveyed
 * selection purely through a background tint would fail a person who cannot
 * separate the two hues — and the card-level treatment has to hold on its own,
 * since the glyph is decorative.
 */
describe("SettingsPage — model option styling", () => {
  const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const ruleBody = (selector: string): string => {
    const esc = selector
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`));
    if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
    return m[1];
  };
  const decl = (body: string, prop: string): string | undefined =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`))?.[1]?.trim();

  it("gives the selected card a shape cue and a weight cue, not only colour", () => {
    const selected = ruleBody(".settings-model-option:has(input:checked)");
    /* `box-shadow` paints the 3px inset rule on the leading edge — a position
       cue. `font-weight` is a weight cue. Either alone would do; both together
       mean the state survives greyscale, and both are absent if someone
       "tidies" the rule down to a background tint. */
    expect(decl(selected, "box-shadow")).toContain("inset");
    expect(decl(selected, "font-weight")).toBeTruthy();
  });

  it("keeps a focus ring on the card, since the input is inset inside it", () => {
    /* The input is a small control at the row's leading edge. A ring drawn on
       the input alone is easy to lose against the card border, so the card
       carries it. Asserted for both required cues: a width and an offset. */
    const focus = ruleBody(".settings-model-option:has(input:focus-visible)");
    expect(decl(focus, "outline")).toMatch(/^\d/);
    expect(decl(focus, "outline-offset")).toBeTruthy();
  });

  it("draws exactly one focus ring — the card's, not the radio's", () => {
    /* The card draws the ring; left alone, the inset radio draws a second one
       inside it. Two stacked rings read as a doubled border rather than as
       focus, so the input's own outline is suppressed deliberately. */
    expect(decl(ruleBody(".settings-model-option input:focus-visible"), "outline")).toBe("none");
  });
});
