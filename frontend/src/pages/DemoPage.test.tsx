import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_DOCUMENTS } from "./demoData";
import { DemoPage } from "./DemoPage";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null }),
}));

const KEY_SEARCH = "askdocs-demo-searches";
const KEY_QA = "askdocs-demo-qa";
const KEY_TOUR = "askdocs-demo-tour-seen";

function renderDemo() {
  return render(
    <MemoryRouter>
      <DemoPage />
    </MemoryRouter>,
  );
}

/** Mounts with the walkthrough already dismissed, so a test about anything else
 *  is not reading the tour's dialog instead. `beforeEach` clears localStorage,
 *  which is what makes the tour open itself. */
function renderDemoWithoutTour() {
  window.localStorage.setItem(KEY_TOUR, "1");
  return renderDemo();
}

/** Closes the walkthrough if it opened, leaving the demo otherwise untouched. */
async function dismissTour(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.queryByRole("dialog");
  if (!dialog) return;
  await user.click(within(dialog).getByRole("button", { name: /close/i }));
}

/** Matches by full textContent containment — needed when a snippet is split
 *  into <mark>/<span> children by query-term highlighting. */
function byContainedText(text: string) {
  return (_content: string, element: Element | null) =>
    element?.textContent?.includes(text) === true;
}

async function runSearch(query: string) {
  fireEvent.change(screen.getByPlaceholderText("Search sample documents..."), {
    target: { value: query },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await act(async () => {});
}

/** Ask lives in the second tab panel, so a test must switch to it first. */
async function askQuestion(question: string) {
  const user = userEvent.setup();
  await dismissTour(user);
  await user.click(screen.getByRole("tab", { name: /^Ask/ }));
  fireEvent.change(
    screen.getByPlaceholderText("Ask a question about the sample documents..."),
    { target: { value: question } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
}

describe("DemoPage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("renders the demo banner, usage limits, and sample documents", async () => {
    const user = userEvent.setup();
    renderDemo();
    await dismissTour(user);

    expect(
      screen.getByText(/Sign up to save your work and access more models/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to home" }).getAttribute("href"),
    ).toBe("/");
    for (const doc of DEMO_DOCUMENTS) {
      expect(screen.getByText(doc.filename)).toBeTruthy();
    }
    expect(screen.getByText(`${DEMO_DOCUMENTS.length} sample docs`)).toBeTruthy();
    // Budget wording, not a countdown: spend *and* ceiling, so a user who never
    // reaches the limit still learns there is one.
    expect(screen.getByText("0 of 10 searches used — 10 left")).toBeTruthy();
    expect(screen.getByText("0 of 5 questions used — 5 left")).toBeTruthy();
    // The budget is stated once. A second copy in the panel — the first draft
    // printed the identical sentence in the header badge and the panel counter —
    // is noise, so the panel stays silent until the budget runs out.
    expect(screen.getAllByText("0 of 10 searches used — 10 left")).toHaveLength(1);
    expect(
      screen.queryByText("Search limit reached for this session."),
    ).toBeNull();
  });

  it("describes what each sample document holds and what it demonstrates", async () => {
    const user = userEvent.setup();
    renderDemo();
    await dismissTour(user);

    for (const doc of DEMO_DOCUMENTS) {
      expect(screen.getByText(doc.description)).toBeTruthy();
    }
  });

  it("returns mock search results and decrements the session search counter", async () => {
    renderDemoWithoutTour();
    expect(screen.getByText("0 of 10 searches used — 10 left")).toBeTruthy();

    await runSearch("benefits");

    expect(
      screen.getAllByText(byContainedText("Review the full benefits catalog in Workday")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Results (1)")).toBeTruthy();
    // The match chip renders the fake relevance as a percentage; query terms
    // are wrapped in <mark> inside the snippet.
    expect(screen.getByText("95% match")).toBeTruthy();
    expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);
    // The filename shows in the document card and in the result card header.
    expect(screen.getAllByText("company-handbook.pdf").length).toBeGreaterThan(1);
    expect(screen.getByText("1 of 10 searches used — 9 left")).toBeTruthy();
    expect(window.sessionStorage.getItem(KEY_SEARCH)).toBe("1");
  });

  it("shows the sign-up CTA instead of searching when the search limit is reached", () => {
    window.sessionStorage.setItem(KEY_SEARCH, "10");
    renderDemo();

    // Scoped to the page: the shared footer also carries a `role="status"`
    // live region, so an unscoped query matches the demo banner and the
    // newsletter's report-back line at once.
    const status = within(screen.getByRole("main")).getByRole("status");
    expect(within(status).getByText("You have reached the demo search limit.")).toBeTruthy();
    expect(
      within(status).getByRole("link", { name: "Sign up" }).getAttribute("href"),
    ).toBe("/register");
    expect(screen.getByPlaceholderText("Search sample documents...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  });

  it("renders a demo assistant answer with a source for a question", async () => {
    renderDemoWithoutTour();
    expect(screen.getByText("0 of 5 questions used — 5 left")).toBeTruthy();

    await askQuestion("What benefits do employees get?");

    expect(screen.getByText("AskDocs demo")).toBeTruthy();
    expect(
      screen.getAllByText(/Answered by the demo assistant/i).length,
    ).toBeGreaterThan(0);
    // The matched source document is listed in the assistant message.
    expect(screen.getAllByText("company-handbook.pdf").length).toBeGreaterThan(1);
    expect(screen.getByText("1 of 5 questions used — 4 left")).toBeTruthy();
    expect(window.sessionStorage.getItem(KEY_QA)).toBe("1");
  });

  it("shows the sign-up CTA instead of answering when the Q&A limit is reached", async () => {
    window.sessionStorage.setItem(KEY_QA, "5");
    const user = userEvent.setup();
    renderDemoWithoutTour();
    await user.click(screen.getByRole("tab", { name: /^Ask/ }));

    // Scoped to the page: the shared footer also carries a `role="status"`
    // live region, so an unscoped query matches the demo banner and the
    // newsletter's report-back line at once.
    const status = within(screen.getByRole("main")).getByRole("status");
    expect(within(status).getByText("You have reached the demo Q&A limit.")).toBeTruthy();
    expect(
      within(status).getByRole("link", { name: "Sign up" }).getAttribute("href"),
    ).toBe("/register");
    expect(
      screen.getByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("counters live in sessionStorage only — never localStorage", async () => {
    renderDemoWithoutTour();

    await runSearch("onboarding");
    await askQuestion("What happens on day one?");

    expect(window.sessionStorage.getItem(KEY_SEARCH)).toBe("1");
    expect(window.sessionStorage.getItem(KEY_QA)).toBe("1");
    expect(window.localStorage.getItem(KEY_SEARCH)).toBeNull();
    expect(window.localStorage.getItem(KEY_QA)).toBeNull();
    // The tour flag is localStorage on purpose, but it is its own key. Asserting
    // `localStorage.length` here would be a false negative — `useTheme` writes a
    // theme key on mount, so the store is not exclusively the tour's.
    expect(window.localStorage.getItem(KEY_TOUR)).toBe("1");
  });

  it("counters survive a reload (re-render) within the same session", () => {
    window.sessionStorage.setItem(KEY_SEARCH, "3");
    window.sessionStorage.setItem(KEY_QA, "2");

    const { unmount } = renderDemoWithoutTour();
    expect(screen.getByText("3 of 10 searches used — 7 left")).toBeTruthy();
    expect(screen.getByText("2 of 5 questions used — 3 left")).toBeTruthy();
    unmount();

    renderDemoWithoutTour();
    expect(screen.getByText("3 of 10 searches used — 7 left")).toBeTruthy();
    expect(screen.getByText("2 of 5 questions used — 3 left")).toBeTruthy();
  });
});
/** `askQuestion` without the tab switch, for callers already on the Ask tab. */
async function askQuestionNow(question: string) {
  fireEvent.change(
    screen.getByPlaceholderText("Ask a question about the sample documents..."),
    { target: { value: question } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await act(async () => {});
}

describe("DemoPage — tabs", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("shows Search and Ask as one real tablist, one panel at a time", async () => {
    const user = userEvent.setup();
    renderDemoWithoutTour();

    const tablist = screen.getByRole("tablist", { name: "Search and ask" });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(2);

    // One visible at a time: the other panel's controls are genuinely absent,
    // not merely hidden. That is what stops the two halves pushing each other
    // down the page, which is what the issue reports.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(
      screen.getByPlaceholderText("Search sample documents..."),
    ).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeNull();

    await user.click(within(tablist).getByRole("tab", { name: /^Ask/ }));
    expect(
      screen.getByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Search sample documents..."),
    ).toBeNull();
  });

  it("keeps each tab's own state across a switch", async () => {
    const user = userEvent.setup();
    renderDemoWithoutTour();

    await runSearch("benefits");
    expect(screen.getByText("Results (1)")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /^Ask/ }));
    await askQuestionNow("What happens on day one?");

    // Back to Search: the results, the query text and the budget all survive.
    await user.click(screen.getByRole("tab", { name: /^Search/ }));
    expect(screen.getByText("Results (1)")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Search sample documents..."),
    ).toHaveValue("benefits");
    expect(screen.getByText("1 of 10 searches used — 9 left")).toBeTruthy();

    // And forward to Ask: the conversation is still there.
    await user.click(screen.getByRole("tab", { name: /^Ask/ }));
    expect(screen.getByText("AskDocs demo")).toBeTruthy();
    expect(screen.getByText("1 of 5 questions used — 4 left")).toBeTruthy();
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    renderDemoWithoutTour();

    screen.getByRole("tab", { name: /^Search/ }).focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: /^Ask/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeTruthy();
    // Wraps, so the tablist is not a dead end at either end.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /^Search/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows each tab's remaining budget in the tab strip", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(KEY_SEARCH, "3");
    renderDemoWithoutTour();

    // The badges carry the long-form budget; the tab hints carry the short form,
    // so the budget for the tab you are *not* on is still visible.
    expect(
      within(screen.getByRole("tab", { name: /^Search/ })).getByText("7 left"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tab", { name: /^Ask/ })).getByText("5 left"),
    ).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /^Ask/ }));
    expect(
      screen.getByPlaceholderText("Ask a question about the sample documents..."),
    ).toBeTruthy();
  });
});

describe("DemoPage — walkthrough", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("opens itself on a first visit and records that it has been seen", async () => {
    const user = userEvent.setup();
    renderDemo();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Step 1 of 3/)).toBeTruthy();
    // Nothing behind it is announced or reachable while it is open.
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The closing button is the last step's label, not the first's.
    expect(
      within(dialog).queryByRole("button", { name: /start exploring/i }),
    ).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(
      within(dialog).getByRole("button", { name: /start exploring/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(KEY_TOUR)).toBe("1");
  });

  it("does not open itself on a later visit", () => {
    window.localStorage.setItem(KEY_TOUR, "1");
    renderDemo();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is re-openable from the page", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEY_TOUR, "1");
    renderDemo();

    await user.click(screen.getByRole("button", { name: /take the tour/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Re-opening starts from the beginning, not where it was left.
    expect(within(screen.getByRole("dialog")).getByText(/Step 1 of 3/)).toBeTruthy();
  });

  it("walks forwards, back, and remembers where it got to", async () => {
    const user = userEvent.setup();
    renderDemo();
    const dialog = () => screen.getByRole("dialog");

    expect(within(dialog()).getByText(/Step 1 of 3/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Next" }));
    expect(within(dialog()).getByText(/Step 2 of 3/)).toBeTruthy();
    await user.click(within(dialog()).getByRole("button", { name: "Next" }));
    expect(within(dialog()).getByText(/Step 3 of 3/)).toBeTruthy();

    await user.click(within(dialog()).getByRole("button", { name: "Back" }));
    expect(within(dialog()).getByText(/Step 2 of 3/)).toBeTruthy();

    await user.click(within(dialog()).getByRole("button", { name: "Back" }));
    expect(within(dialog()).getByText(/Step 1 of 3/)).toBeTruthy();
    // "Back" is absent on the first step rather than a dead control.
    expect(within(dialog()).queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("dismisses on Escape and on the close button, and both count as seen", async () => {
    const user = userEvent.setup();

    renderDemo();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(KEY_TOUR)).toBe("1");

    window.localStorage.clear();
    renderDemo();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem(KEY_TOUR)).toBe("1");
  });

  it("moves focus in on open and returns it to the button that opened it", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(KEY_TOUR, "1");
    renderDemo();

    const trigger = screen.getByRole("button", { name: /take the tour/i });
    await user.click(trigger);
    // Focus is inside the dialog, not left behind on the trigger.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab inside the dialog rather than letting it escape behind", async () => {
    const user = userEvent.setup();
    renderDemo();
    const dialog = screen.getByRole("dialog");

    // Tab from the last control wraps to the first rather than moving into the
    // page content the backdrop is covering.
    const close = within(dialog).getByRole("button", { name: /close/i });
    close.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
  });
});
