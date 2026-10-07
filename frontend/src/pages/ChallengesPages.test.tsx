import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ChallengesPage } from "./ChallengesPage";
import { NewChallengePage } from "./NewChallengePage";
import {
  CHALLENGE_FIELDS,
  TASK_FIELD,
  CHALLENGES_EMPTY,
  CHALLENGES_NOT_SAVED,
  CHALLENGES_SUBTITLE,
  CHALLENGES_TITLE,
  NEW_CHALLENGE_CTA,
  NEW_CHALLENGE_HEADING,
  NEW_CHALLENGE_INTRO,
  NEW_CHALLENGE_TITLE,
} from "../content/challenges";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }),
}));

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("ChallengesPage", () => {
  it("renders the title and subtitle the page was specified with", () => {
    render(
      <MemoryRouter>
        <ChallengesPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: CHALLENGES_TITLE })).toBeTruthy();
    expect(screen.getByText(CHALLENGES_SUBTITLE)).toBeTruthy();
  });

  it("puts the create button in the hero, centred under the subtitle", () => {
    const { container } = render(
      <MemoryRouter>
        <ChallengesPage />
      </MemoryRouter>,
    );

    // The whole point of the change: the action belongs to the title block, so
    // it lives in the hero's centred column rather than beside the title.
    const action = container.querySelector(".page-hero-action");
    expect(action).not.toBeNull();

    const link = within(action as HTMLElement).getByRole("link", {
      name: NEW_CHALLENGE_CTA,
    });
    expect(link.getAttribute("href")).toBe("/challenges/new");

    // Inside `.page-hero-inner`, which is the centred flex column.
    expect(action?.closest(".page-hero-inner")).not.toBeNull();
  });

  it("keeps the plus sign out of the accessible name", () => {
    render(
      <MemoryRouter>
        <ChallengesPage />
      </MemoryRouter>,
    );

    // `aria-hidden` on the glyph, so the link is announced as "New challenge"
    // rather than "plus new challenge".
    const link = screen.getByRole("link", { name: NEW_CHALLENGE_CTA });
    expect(link.querySelector(".hero-plus")?.getAttribute("aria-hidden")).toBe("true");
    expect(link.textContent).toContain("+");
  });

  it("shows an empty state instead of invented challenges", () => {
    render(
      <MemoryRouter>
        <ChallengesPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(CHALLENGES_EMPTY.title)).toBeTruthy();
    expect(screen.getByText(CHALLENGES_EMPTY.body)).toBeTruthy();
    // The empty state must not carry a second copy of the hero CTA — two
    // identical buttons a scroll apart read as two different offers.
    expect(screen.getAllByRole("link", { name: NEW_CHALLENGE_CTA })).toHaveLength(1);
  });

  it("does not render any challenge cards", () => {
    const { container } = render(
      <MemoryRouter>
        <ChallengesPage />
      </MemoryRouter>,
    );

    // Guards the honest-empty-state rule: sample data that looks real is worse
    // than no data, because a visitor cannot tell it apart from the real thing.
    expect(container.querySelectorAll(".challenge-card")).toHaveLength(0);
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });
});

describe("NewChallengePage", () => {
  function renderForm() {
    return render(
      <MemoryRouter>
        <NewChallengePage />
      </MemoryRouter>,
    );
  }

  it("renders the title, heading and description it was specified with", () => {
    renderForm();

    expect(screen.getByRole("heading", { level: 1, name: NEW_CHALLENGE_TITLE })).toBeTruthy();
    expect(screen.getByText(NEW_CHALLENGE_HEADING)).toBeTruthy();
    expect(screen.getByText(NEW_CHALLENGE_INTRO)).toBeTruthy();
  });

  it("asks for exactly the three things a challenge is made of", () => {
    renderForm();

    for (const field of CHALLENGE_FIELDS) {
      // A real <label for>, so clicking the label focuses the control — which
      // is also what makes the label the accessible name.
      expect(screen.getByLabelText(field.label)).toBeTruthy();
    }
    expect(CHALLENGE_FIELDS.map((f) => f.name)).toEqual(["task", "prompt", "tests"]);
  });

  it("does not use the placeholder as the only guidance", () => {
    renderForm();

    for (const field of CHALLENGE_FIELDS) {
      const control = screen.getByLabelText(field.label);
      expect(control.getAttribute("placeholder")).toBe(field.hint);
      // The requirement is stated below the control, where it survives focus.
      expect(screen.getByText(field.help)).toBeTruthy();
      // And it is *different* text: repeating the placeholder verbatim a few
      // pixels below it reads as a copy-paste artifact, so the placeholder stays
      // a sample of the expected shape and `help` carries the requirement.
      expect(field.help).not.toBe(field.hint);
    }
  });

  it("describes each control by its hint, its help and any error", async () => {
    const user = userEvent.setup();
    renderForm();

    const describedBy = (
      screen.getByLabelText(TASK_FIELD.label).getAttribute("aria-describedby") ?? ""
    ).split(" ");
    // Just the help text: the placeholder is not announced as a description, so
    // there is nothing else to point at.
    expect(describedBy).toHaveLength(1);

    // Submitting empty appends the error id to the same list.
    await user.click(screen.getByRole("button", { name: /create challenge/i }));
    await waitFor(() =>
      expect(
        screen.getByLabelText(TASK_FIELD.label).getAttribute("aria-describedby") ?? "",
      ).toContain("-error"),
    );
  });

  it("blocks an empty submit and marks every field invalid", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    await waitFor(() => {
      expect(screen.getByText(/The coding task is required\./)).toBeTruthy();
      expect(screen.getByText(/The prompt your LLM will see is required\./)).toBeTruthy();
      expect(screen.getByText(/Tests used to grade the solution is required\./)).toBeTruthy();
    });

    for (const field of CHALLENGE_FIELDS) {
      expect(screen.getByLabelText(field.label).getAttribute("aria-invalid")).toBe("true");
    }
    // A validation failure must not also claim the form was submitted.
    expect(screen.queryByText(CHALLENGES_NOT_SAVED.title)).toBeNull();
  });

  it("clears a field's error as soon as it is edited", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("button", { name: /create challenge/i }));
    await waitFor(() => expect(screen.getByText(/The coding task is required\./)).toBeTruthy());

    await user.type(screen.getByLabelText(TASK_FIELD.label), "Merge two sorted lists");

    await waitFor(() => expect(screen.queryByText(/The coding task is required\./)).toBeNull());
    // The other fields' errors are untouched.
    expect(screen.getByText(/The prompt your LLM will see is required\./)).toBeTruthy();
  });

  it("reports honestly that nothing was saved rather than faking success", async () => {
    const user = userEvent.setup();
    const { container } = renderForm();

    for (const field of CHALLENGE_FIELDS) {
      await user.type(screen.getByLabelText(field.label), "something");
    }
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    await waitFor(() => expect(screen.getByText(CHALLENGES_NOT_SAVED.title)).toBeTruthy());
    // The title and body are separate nodes inside one notice, so the element
    // carries the full sentence. Queried by class rather than `role="status"`,
    // which the page chrome also uses for its own live regions.
    const notice = container.querySelector(".challenge-notice");
    expect(notice?.textContent).toContain(CHALLENGES_NOT_SAVED.body);
    expect(notice?.getAttribute("role")).toBe("status");

    // The point of the notice: it must not read as a success.
    expect(screen.queryByText(/challenge created/i)).toBeNull();
    expect(screen.queryByText(/saved successfully/i)).toBeNull();

    // And the work is still on screen rather than thrown away.
    expect((screen.getByLabelText(TASK_FIELD.label) as HTMLTextAreaElement).value).toBe(
      "something",
    );
  });

  it("carries no network call on submit", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    renderForm();

    for (const field of CHALLENGE_FIELDS) {
      await user.type(screen.getByLabelText(field.label), "something");
    }
    await user.click(screen.getByRole("button", { name: /create challenge/i }));

    await waitFor(() => expect(screen.getByText(CHALLENGES_NOT_SAVED.title)).toBeTruthy());
    // There is no endpoint behind this form, so submitting must not invent one.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("offers a way back to the index", () => {
    renderForm();

    const cancel = screen.getByRole("link", { name: /cancel/i });
    expect(cancel.getAttribute("href")).toBe("/challenges");
  });
});
