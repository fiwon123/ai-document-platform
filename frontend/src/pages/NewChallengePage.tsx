import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { PageLayout, PageSection, TemplateNotice } from "../components/PageLayout";
import {
  CHALLENGE_FIELDS,
  CHALLENGES_NOT_SAVED,
  NEW_CHALLENGE_HEADING,
  NEW_CHALLENGE_INTRO,
  NEW_CHALLENGE_TITLE,
} from "../content/challenges";

type FieldName = (typeof CHALLENGE_FIELDS)[number]["name"];
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const EMPTY: Values = { task: "", prompt: "", tests: "" };

/**
 * `/challenges/new` — the create form.
 *
 * The three inputs are the three things a challenge *is*: the task, the prompt
 * the model will see, and the bar its solution has to clear. They are defined
 * once in `content/challenges` and rendered from there, so the form cannot
 * present a third field that the copy never mentions.
 *
 * ## It does not save, and it says so
 *
 * There is no `/v1/challenges` endpoint. Submitting therefore cannot persist
 * anything, so the submit handler validates and then shows an honest notice
 * instead of a success state — a "Challenge created" confirmation that no
 * request backs would leave the user believing their work was stored. The text
 * also keeps them on the page, where the text they just typed still is.
 */
export function NewChallengePage() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);
  const formId = useId();

  const setField = (name: FieldName, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    // Clear this field's error as soon as it is edited, rather than on the next
    // submit. Re-reporting "this field is empty" at someone who is filling it in
    // is the kind of thing that makes people stop using a form.
    setErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const next: Errors = {};
    for (const field of CHALLENGE_FIELDS) {
      if (!values[field.name].trim()) {
        next[field.name] = `${field.label} is required.`;
      }
    }

    setErrors(next);
    // Only claim the form was submitted when it actually validated. Setting it
    // unconditionally would show the notice next to a form that is still wrong.
    setSubmitted(Object.keys(next).length === 0);

    if (Object.keys(next).length > 0) {
      // Move focus to the first field that needs attention, so the error is not
      // only a coloured border somewhere above the fold.
      const first = CHALLENGE_FIELDS.find((f) => next[f.name]);
      if (first) document.getElementById(`${formId}-${first.name}`)?.focus();
    }
  };

  const errorCount = Object.keys(errors).length;

  return (
    /* "Create a challenge" is the hero subtitle, not a section heading: it
       belongs to the title block, and `PageLayout` renders the subtitle in the
       hero directly under the h1 — which is also the order the copy reads in
       (title, then what this page does, then the detail). The long description
       goes in the body, where it has the measure to be read rather than
       scanned. */
    <PageLayout title={NEW_CHALLENGE_TITLE} subtitle={NEW_CHALLENGE_HEADING}>
      <PageSection>
        <p className="challenge-intro">{NEW_CHALLENGE_INTRO}</p>

        <TemplateNotice>
          This form is not connected to a server yet. It validates what you type and reports back,
          but nothing is stored, queued, or sent to a model.
        </TemplateNotice>

        <form className="challenge-form" onSubmit={handleSubmit} noValidate>
          {/* Announced on submit so the reason a field is marked invalid is
              available without hunting for it. `aria-live="assertive"` because
              it is the direct response to a button press, not background news. */}
          <p className="sr-only" role="alert">
            {errorCount > 0
              ? `${errorCount} field${errorCount === 1 ? "" : "s"} need attention.`
              : ""}
          </p>

          {CHALLENGE_FIELDS.map((field) => {
            const fieldId = `${formId}-${field.name}`;
            const helpId = `${fieldId}-help`;
            const errorId = `${fieldId}-error`;
            const error = errors[field.name];
            return (
              <div className="form-group" key={field.name}>
                <label htmlFor={fieldId}>{field.label}</label>
                <textarea
                  id={fieldId}
                  name={field.name}
                  rows={field.rows}
                  value={values[field.name]}
                  placeholder={field.hint}
                  /* "off" because none of these three is an autofill target —
                     they are authored prose, not a name, address or password.
                     Required by `formAutofill.test.ts`, which scans the source
                     so a control cannot ship without it. */
                  autoComplete="off"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={
                    [helpId, error ? errorId : null].filter(Boolean).join(" ") || undefined
                  }
                  onChange={(event) => setField(field.name, event.target.value)}
                />
                {/* The placeholder is an *example* and disappears on focus, so
                    it cannot be the only place the requirement is written — hence
                    this. It is deliberately not the placeholder repeated: the
                    same string twice on screen reads as a copy-paste artifact,
                    so `help` is the guidance and the placeholder stays the
                    sample. */}
                <p className="form-help" id={helpId}>
                  {field.help}
                </p>
                {error && (
                  <p className="form-error" id={errorId}>
                    {error}
                  </p>
                )}
              </div>
            );
          })}

          <div className="challenge-form-actions">
            <button type="submit" className="btn btn-primary btn-lg">
              Create challenge
            </button>
            <Link to="/challenges" className="btn btn-secondary btn-lg">
              Cancel
            </Link>
          </div>
        </form>

        {submitted && (
          <aside className="challenge-notice" role="status">
            <strong>{CHALLENGES_NOT_SAVED.title}</strong> {CHALLENGES_NOT_SAVED.body}
          </aside>
        )}
      </PageSection>
    </PageLayout>
  );
}
