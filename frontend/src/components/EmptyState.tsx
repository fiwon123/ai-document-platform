import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface EmptyStateAction {
  label: string;
  to?: string;
  onClick?: () => void;
}

interface EmptyStateProps {
  /** Optional icon; defaults to a lightweight document glyph. */
  icon?: ReactNode;
  /** Short heading shown above the description. */
  title: string;
  /** Optional supporting copy below the title. */
  description?: string;
  /** CTA: an object rendered as a primary button/link, or any custom node. */
  action?: EmptyStateAction | ReactNode;
  /** Extra content rendered alongside the CTA. */
  children?: ReactNode;
}

function EmptyStateIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

function isActionObject(
  action: EmptyStateProps["action"],
): action is EmptyStateAction {
  return (
    typeof action === "object" &&
    action !== null &&
    !Array.isArray(action) &&
    "label" in action
  );
}

function renderAction(action: EmptyStateProps["action"]): ReactNode {
  if (action === undefined || action === null) return null;
  if (!isActionObject(action)) return action;

  const { label, to, onClick } = action;
  const className = "btn btn-primary";
  if (to) {
    return (
      <Link to={to} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  children,
}: EmptyStateProps) {
  const renderedAction = renderAction(action);
  const hasAction = renderedAction !== null || children !== undefined;

  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon ?? <EmptyStateIcon />}</div>
      <h3 className="empty-state-title">{title}</h3>
      {description ? (
        <p className="empty-state-description">{description}</p>
      ) : null}
      {hasAction ? (
        <div className="empty-state-action">
          {renderedAction}
          {children}
        </div>
      ) : null}
    </div>
  );
}