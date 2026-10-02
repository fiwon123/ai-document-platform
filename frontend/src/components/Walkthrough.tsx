import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface TourStep {
  title: string;
  body: ReactNode;
}

/**
 * A dismissible, re-openable walkthrough.
 *
 * Shown automatically on a first visit and re-openable from a trigger button.
 * Deliberately a modal `role="dialog"`: it interrupts, so it must not leave
 * focus free to wander the page behind it.
 *
 * Two things the pattern is easy to get wrong, and so are handled here:
 *
 *  - **Focus must not stay where it was.** Opening this while the trigger has
 *    focus leaves a screen reader announcing the trigger again and Tab walking
 *    the page *behind* an "overlay" that is not one. Focus moves in, and
 *    returns to the trigger on close, so dismissing puts the user back exactly
 *    where they were.
 *  - **Tab must cycle inside.** Without a trap, Tab walks out of the dialog and
 *    into content the dialog is covering, which is exactly the confusion a
 *    modal exists to prevent.
 *
 * Escape dismisses at any step. Steps are rendered all at once in the DOM only
 * while the walkthrough is open, and only the current one is visible, so a step
 * change is a text swap rather than a remount.
 */
export function Walkthrough({
  steps,
  onClose,
}: {
  steps: TourStep[];
  /** Called on every exit path — finish, close button or Escape. The caller
   *  records "seen" here and restores focus to whatever opened it. */
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const lastStep = index >= steps.length - 1;

  // Move focus into the dialog on open, so the first Tab lands inside it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function close() {
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Wrap at both ends; without this, Tab escapes into the page behind.
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const step = steps[index];
  if (!step) return null;

  return (
    <div className="tour-backdrop" onKeyDown={handleKeyDown}>
      <div
        className="tour"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="tour-head">
          <h2 className="tour-title" id={titleId}>
            {step.title}
          </h2>
          <button
            type="button"
            className="tour-close"
            onClick={close}
            aria-label="Close the walkthrough"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="tour-body" id={descId}>
          {step.body}
        </div>

        <div className="tour-foot">
          <p className="tour-progress" aria-live="polite">
            Step {index + 1} of {steps.length}
          </p>
          <div className="tour-actions">
            {index > 0 && (
              <button type="button" className="btn btn-secondary" onClick={() => setIndex(index - 1)}>
                Back
              </button>
            )}
            {lastStep ? (
              <button type="button" className="btn btn-primary" onClick={close}>
                Start exploring
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => setIndex(index + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}