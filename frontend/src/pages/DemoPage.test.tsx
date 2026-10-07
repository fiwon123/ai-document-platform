import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  fireEvent.change(screen.getByPlaceholderText("Ask about the sample documents..."), {
    target: { value: question },
  });
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

    expect(screen.getByText(/Sign up to save your work and access more models/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to home" }).getAttribute("href")).toBe("/");
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
    expect(screen.queryByText("Search limit reached for this session.")).toBeNull();
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
    expect(within(status).getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      "/register",
    );
    expect(screen.getByPlaceholderText("Search sample documents...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  });

  it("renders a demo assistant answer with a source for a question", async () => {
    renderDemoWithoutTour();
    expect(screen.getByText("0 of 5 questions used — 5 left")).toBeTruthy();

    await askQuestion("What benefits do employees get?");

    expect(screen.getByText("AskDocs demo")).toBeTruthy();
    expect(screen.getAllByText(/Answered by the demo assistant/i).length).toBeGreaterThan(0);
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
    expect(within(status).getByRole("link", { name: "Sign up" }).getAttribute("href")).toBe(
      "/register",
    );
    expect(screen.getByPlaceholderText("Ask about the sample documents...")).toBeDisabled();
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
  fireEvent.change(screen.getByPlaceholderText("Ask about the sample documents..."), {
    target: { value: question },
  });
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
    expect(screen.getByPlaceholderText("Search sample documents...")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Ask about the sample documents...")).toBeNull();

    await user.click(within(tablist).getByRole("tab", { name: /^Ask/ }));
    expect(screen.getByPlaceholderText("Ask about the sample documents...")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search sample documents...")).toBeNull();
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
    expect(screen.getByPlaceholderText("Search sample documents...")).toHaveValue("benefits");
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

    expect(screen.getByRole("tab", { name: /^Ask/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("Ask about the sample documents...")).toBeTruthy();
    // Wraps, so the tablist is not a dead end at either end.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /^Search/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows each tab's remaining budget in the tab strip", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(KEY_SEARCH, "3");
    renderDemoWithoutTour();

    // The badges carry the long-form budget; the tab hints carry the short form,
    // so the budget for the tab you are *not* on is still visible.
    expect(within(screen.getByRole("tab", { name: /^Search/ })).getByText("7 left")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /^Ask/ })).getByText("5 left")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /^Ask/ }));
    expect(screen.getByPlaceholderText("Ask about the sample documents...")).toBeTruthy();
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
    expect(within(dialog).queryByRole("button", { name: /start exploring/i })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: /start exploring/i }));
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
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }));
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

    /* From the *last* focusable control, not the first. Tabbing forward from the
       close button lands on "Next", which is still inside the dialog, so that
       direction proves nothing about the trap. Tabbing forward off the last
       control is the case that would otherwise walk into the page behind. */
    const last = within(dialog).getByRole("button", { name: "Next" });
    last.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Wrapped to the first control rather than to the page behind.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /close/i }));
  });

  it("wraps backwards from the first control to the last", async () => {
    const user = userEvent.setup();
    renderDemo();
    const dialog = screen.getByRole("dialog");

    const first = within(dialog).getByRole("button", { name: /close/i });
    first.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Next" }));
  });
});

describe("DemoPage — placeholder fit", () => {
  /* An `input`'s placeholder is clipped at its content edge with no ellipsis,
     so a placeholder that is too long is silently cut mid-word rather than
     wrapped or truncated visibly. At 375px the Ask input's content box is 295px
     and the measured average character is ~7.9px there, so ~37 characters fit;
     "Ask a question about the sample documents..." is 42 and rendered as
     "Ask a question about the sample docume".

     jsdom cannot measure text, so this pins the character budget rather than a
     pixel width — enough to fail when the placeholder is lengthened, which is
     how the bug got there. The number is deliberately loose: a retune of the
     input's padding should not fail this file. */
  const MAX_PLACEHOLDER_CHARS = 37;

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("keeps the Ask placeholder inside the narrow input's character budget", async () => {
    const user = userEvent.setup();
    renderDemoWithoutTour();
    await user.click(screen.getByRole("tab", { name: /^Ask/ }));

    const input = screen.getByPlaceholderText("Ask about the sample documents...");
    const placeholder = input.getAttribute("placeholder") ?? "";
    expect(placeholder.length).toBeLessThanOrEqual(MAX_PLACEHOLDER_CHARS);
    // The descriptive label is the accessible name, so shortening the visible
    // hint does not shorten what a screen reader announces.
    expect(input.getAttribute("aria-label")).toBe("Ask a question about the sample documents");
  });

  it("keeps the Search placeholder inside the same budget", () => {
    renderDemoWithoutTour();
    const placeholder =
      screen.getByPlaceholderText("Search sample documents...").getAttribute("placeholder") ?? "";
    expect(placeholder.length).toBeLessThanOrEqual(MAX_PLACEHOLDER_CHARS);
  });
});

describe("DemoPage — stylesheet invariants", () => {
  /* Two visual-review findings that no component test could catch, because both
     are about a rendered box rather than about what a component emits. Asserted
     here as *relationships*, following src/pageMeasure.test.ts: a deliberate
     retune of the padding scale should not fail this file, but the two specific
     mistakes — a block with no inset, and no word gap on an uppercase sentence —
     must. */

  const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  /* The selector is escaped before it becomes a pattern. `.demo-usage .badge`
     happened to work unescaped because `.` matches itself loosely, and
     `.demo-doc-description + .document-card-body` silently did not: `+` is a
     quantifier there, so the pattern asked for one-or-more spaces where the
     combinator should have been, matched nothing, and threw "no ... block in the
     stylesheet" — a failure in the helper that looks like a failure in the CSS. */
  const ruleBody = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`));
    if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
    return m[1];
  };
  const decl = (body: string, prop: string): string | undefined =>
    body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`))?.[1]?.trim();

  it("insets the sample-document description like every other block in the card", () => {
    /* `.document-card-header` and `.document-card-body` both carry
       `padding: var(--sp-5)`. As a bare direct child, `.demo-doc-description`
       rendered flush against the card border — measured 1–2px from the left
       edge while everything inside sat 20px in, which read as a misaligned
       block. Asserted against the card's own token, so a change to the padding
       scale moves both together. */
    const card = decl(ruleBody(".document-card-header"), "padding");
    expect(card).toContain("--sp-5");

    const desc = ruleBody(".demo-doc-description");
    const padding = decl(desc, "padding") ?? "";
    const paddingLeft = decl(desc, "padding-left");
    const horizontal = paddingLeft ?? padding;
    expect(
      horizontal,
      "the description needs a horizontal inset or it renders on the card border",
    ).toContain("--sp-5");
    /* Vertical padding would double up: the header above and the body below
       each already contribute their own, which opened a ~46px void. */
    expect(padding.trim()).toBe(`0 var(--sp-5)`);
  });

  it("keeps a word gap on the uppercase budget badges", () => {
    /* `.badge` sets `text-transform: uppercase` with `letter-spacing: 0.03em`.
       Correct for a one- or two-word status chip, wrong for a sentence: the
       budget read as "1OF5 QUESTIONS USED" because the word gap (2.8–4.5px) was
       barely wider than the glyph gap (1–2px). */
    const usageBadge = ruleBody(".demo-usage .badge");
    expect(decl(usageBadge, "word-spacing")).toBeTruthy();

    /* The same defect appeared twice: the rule was first written for
       `.demo-usage .badge` and the tab hints — one selector over — still
       rendered "10left" with a word gap equal to its digit gap. Asserted across
       every label-bearing pill on the page so a third cannot slip through. */
    const tabHint = ruleBody(".tab-hint");
    expect(
      decl(tabHint, "word-spacing"),
      'the tab hint fuses "10 left" into "10left" without a word gap',
    ).toBeTruthy();
  });

  it("bottom-anchors the demo card body so status rows align across cards", () => {
    /* `.document-card-body` is `flex: 1`, which grows the box but leaves its
       children top-aligned; only `.document-card-footer` carries
       `margin-top: auto`, and the demo renders no footer element. So the status
       row tracked the height of the description above it and sat ~21px lower in
       whichever card wrapped to an extra line. */
    const body = ruleBody(".demo-doc-description + .document-card-body");
    expect(decl(body, "display")).toBe("flex");
    expect(decl(body, "flex-direction")).toBe("column");
    expect(decl(body, "justify-content")).toBe("flex-end");
  });
});
