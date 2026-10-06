import { useId } from "react";

export type DocumentView = "grid" | "table";

/**
 * Grid ⇄ table switch for the documents list (#587).
 *
 * Built as a real radiogroup rather than a pair of buttons: the two options are
 * mutually exclusive and the choice should be announced as one, so arrow keys
 * move between them and a screen reader says "2 of 2" rather than reading two
 * unrelated toggles. `role="radio"` + `aria-checked` carries the state, and
 * `aria-controls` points at the region being rearranged so it is clear the
 * switch changes the *presentation* and not the data.
 *
 * The label is read out ("Layout") but not painted as a heading, which is why
 * it is a `role="radiogroup"` `aria-label` rather than visible text: the group
 * is self-evident visually (two icons) and a visible "Layout" label beside it
 * competes with the filename filter it sits next to.
 */
export function DocumentViewToggle({
  view,
  onChange,
  controlsId,
}: {
  view: DocumentView;
  onChange: (view: DocumentView) => void;
  controlsId: string;
}) {
  const groupId = useId();

  const options: { value: DocumentView; label: string }[] = [
    { value: "grid", label: "Grid view" },
    { value: "table", label: "Table view" },
  ];

  return (
    <div
      className="view-toggle"
      role="radiogroup"
      aria-label="Document layout"
      onKeyDown={(e) => {
        const order = options.map((o) => o.value);
        // Anchor on what actually has focus, not on `view`. They are the same
        // thing in normal use (selection follows focus), but anchoring on the
        // selection makes the keys relative to the wrong option the moment they
        // are not: focus the unselected button and press ArrowLeft, and the
        // direction is computed from the selected one instead of the one the
        // key was pressed on.
        const active = document.activeElement;
        const activeIndex = order.findIndex((v) => active?.id === `${groupId}-${v}`);
        const i = activeIndex >= 0 ? activeIndex : Math.max(0, order.indexOf(view));
        const step =
          e.key === "ArrowRight" || e.key === "ArrowDown"
            ? 1
            : e.key === "ArrowLeft" || e.key === "ArrowUp"
              ? -1
              : 0;
        // step === 0 means an unhandled key: bail before moving anything.
        if (step === 0) return;
        const next = order[(i + step + order.length) % order.length]!;
        e.preventDefault();
        // Selection follows focus: with two options there is nothing to
        // preview, so moving focus is the choice. Waiting for Enter would make
        // arrow keys move focus over content that has not changed yet, which is
        // the more confusing of the two.
        onChange(next);
        // The newly focused control is a different element, so the key event
        // does not carry focus across on its own.
        document.getElementById(`${groupId}-${next}`)?.focus();
      }}
    >
      {options.map((o) => {
        const selected = view === o.value;
        return (
          <button
            key={o.value}
            id={`${groupId}-${o.value}`}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-controls={controlsId}
            // Roving tabindex: the group is one tab stop, and arrows move within
            // it. Without this, the group is two. Keyed to the selected option
            // because selection follows focus, so the tab stop and the focused
            // option are always the same element.
            tabIndex={selected ? 0 : -1}
            className={`view-toggle-option${selected ? " is-selected" : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.value === "grid" ? <GridIcon /> : <TableIcon />}
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M3 15h18M9.5 9.5V20" />
    </svg>
  );
}
