import type { PlanCell } from "../../content/marketing";

/** Stroked line icon used on feature cards and pipeline stages. */
export function FeatureIcon({ path }: { path: string }) {
  return (
    <svg
      className="feature-icon"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg
      className="compare-check"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m5 13 4 4L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg
      className="compare-x"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * One cell of the plan comparison table.
 *
 * A boolean renders as an icon plus visually hidden text. The icon alone is not
 * enough: a tick and a cross both carry their meaning visually, but hiding both
 * from assistive tech leaves a screen reader announcing an *empty* cell, which
 * in a limits table reads as "no data" rather than "this plan does not include
 * it". The text is the accessible content; the icon is the decoration.
 */
export function PlanCellValue({ value }: { value: PlanCell }) {
  if (value === true) {
    return (
      <>
        <CheckIcon />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <XIcon />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <>{value}</>;
}
