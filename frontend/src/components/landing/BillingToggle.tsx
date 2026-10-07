/**
 * The Monthly / Annual switch above the plan cards.
 *
 * Shared by the landing page and `/pricing` because both had their own copy of
 * this markup, and #583 is a fix to the *control* — centring it and giving the
 * selected state a cue that is not colour. Fixing one copy and leaving the
 * other is how the two drifted in the first place.
 */
export interface BillingToggleProps {
  /** Whether the annual price is showing. */
  annual: boolean;
  /** Called with the value the toggle should move to. */
  onChange: (annual: boolean) => void;
}

export function BillingToggle({ annual, onChange }: BillingToggleProps) {
  return (
    <div className="billing-toggle-row">
      <div className="billing-toggle">
        {/* Each label is a real button so the period can be chosen directly,
            rather than by clicking a switch that happens to sit between two
            read-only words. The switch below stays as the coarse control. */}
        <button
          type="button"
          className={`billing-toggle-label${annual ? "" : " active"}`}
          aria-pressed={!annual}
          onClick={() => onChange(false)}
        >
          Monthly
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          aria-label="Toggle annual billing"
          className="toggle-switch"
          onClick={() => onChange(!annual)}
        >
          <span className="toggle-thumb" />
        </button>
        <button
          type="button"
          className={`billing-toggle-label${annual ? " active" : ""}`}
          aria-pressed={annual}
          onClick={() => onChange(true)}
        >
          Annual <em className="save-badge">Save 17%</em>
        </button>
      </div>
    </div>
  );
}
