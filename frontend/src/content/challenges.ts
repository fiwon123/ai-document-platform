/**
 * Challenges — copy for the `/challenges` pages.
 *
 * Separate from `marketing.ts` for the same reason the legal documents want to
 * be (#618): this is one self-contained feature's words, and it is short. The
 * feature's routes are still listed in `MARKETING_ROUTES` so the routing test
 * and the sitemap keep covering them.
 *
 * ## There are no challenges yet
 *
 * This module deliberately declares no sample challenges. The feature is
 * frontend-only for now — there is no `/v1/challenges` endpoint and nothing to
 * list — and inventing plausible-looking entries would be the one thing a
 * visitor could not distinguish from real data. So `/challenges` renders an
 * empty state that says so.
 *
 * That is the same call the blog index makes (`AGENTS.md` → *Honest absent
 * affordances*). If challenges are ever seeded from a fixture file, put them
 * here as a `CHALLENGES` array — and keep the empty state for the real
 * no-data case, because a list that can only ever be empty is a list that never
 * gets tested against a populated state.
 */

export const CHALLENGES_TITLE = "Challenges";

export const CHALLENGES_SUBTITLE =
  "Submit a challenge and let an LLM generate and evaluate a solution.";

export const NEW_CHALLENGE_CTA = "New challenge";

export const NEW_CHALLENGE_TITLE = "New challenge";

export const NEW_CHALLENGE_HEADING = "Create a challenge";

export const NEW_CHALLENGE_INTRO =
  "Define a coding task, the prompt your LLM will see, and the tests used to grade the generated solution.";

/** The three inputs a challenge is made of, in the order the form asks for them.
 *
 *  `hint` is the field's placeholder *and* its help text. One string, because a
 *  placeholder is not a label: it disappears on focus and is not reliably read by
 *  assistive tech, so it cannot be the only place the requirement is written.
 */
export type ChallengeField = {
  name: "task" | "prompt" | "tests";
  label: string;
  hint: string;
  /** Longer prose shown under the field, where it can be read at leisure. */
  help: string;
  rows: number;
};

/* Exported individually as well as in the array below. The form iterates the
   array, but a test (or anything else) that cares about one field should be able
   to name it — `CHALLENGE_FIELDS[0]` is `T | undefined` under
   `noUncheckedIndexedAccess`, which turns a field lookup into a type error
   instead of a reference. */
export const TASK_FIELD: ChallengeField = {
  name: "task",
  label: "The coding task",
  hint: "e.g. Write a function that merges two sorted lists",
  help: "What the solution has to do. State it the way you would state it to a person: inputs, outputs, and the edge cases that matter.",
  rows: 3,
};

export const PROMPT_FIELD: ChallengeField = {
  name: "prompt",
  label: "The prompt your LLM will see",
  hint: "The exact text handed to the model",
  help: "Verbatim, as the model will receive it. This is the only thing it knows about the task, so anything you leave out of it is not being asked for.",
  rows: 5,
};

export const TESTS_FIELD: ChallengeField = {
  name: "tests",
  label: "Tests used to grade the solution",
  hint: "One assertion per line",
  help: "The bar a generated solution has to clear. Written out here rather than executed, so grading is a review against these, not a run of them.",
  rows: 5,
};

/** Render order for the form. Built from the three above, so the array and the
 *  named exports cannot drift apart. */
export const CHALLENGE_FIELDS: ChallengeField[] = [
  TASK_FIELD,
  PROMPT_FIELD,
  TESTS_FIELD,
];

/** Empty state for `/challenges`, shown because there is genuinely no data. */
export const CHALLENGES_EMPTY = {
  title: "No challenges yet",
  body: "Nobody has submitted one. Be the first — a challenge is a coding task, the prompt your LLM will see, and the tests its solution has to pass.",
} as const;

/**
 * What the form says when it is submitted.
 *
 * Honest, and deliberately not a success message. There is no endpoint behind
 * this form yet, so a "Challenge created" confirmation would be a lie the UI
 * tells on purpose — the user would leave believing their work was saved. It
 * says what actually happened and keeps the work on screen.
 */
export const CHALLENGES_NOT_SAVED = {
  title: "Nothing was submitted",
  body: "This form is not connected to a server yet, so your challenge was not saved or sent anywhere. It is still here on this page — copy it somewhere safe, or check back when saving lands.",
} as const;