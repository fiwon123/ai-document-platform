import { useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  /** Rendered inside the tab button after the label — e.g. a remaining-budget note. */
  hint?: ReactNode;
}

/**
 * A fully-implemented ARIA tab pattern.
 *
 * The codebase has previously declined `role="tablist"` on a carousel because a
 * tablist *obliges* a set of behaviours — `role="tab"` children, a matching
 * `role="tabpanel"`, `aria-selected`, roving tabindex, arrow-key navigation —
 * and claiming the role without them fails `aria-required-children`. That is
 * the correct call for a row of dots. Here the issue asks for tabs outright, so
 * this component implements the whole pattern rather than the label:
 *
 *  - Arrow keys move between tabs, wrapping at both ends; Home/End jump to the
 *    first/last.
 *  - Selection follows focus (automatic activation). With two panels whose
 *    contents are cheap to render, making the user press Enter again to see what
 *    they just arrowed onto is a cost with no benefit.
 *  - Roving tabindex: exactly one tab is in the page's tab order, so Tab moves
 *    *out* of the tablist rather than through every tab. That is the behaviour
 *    `role="tab"` requires, and it is why the tablist is one tab stop.
 *  - Each panel is labelled by its tab, so a screen reader announces which tab
 *    it is in when focus lands there.
 *
 * Only the active panel's children are rendered. State that must survive a
 * switch therefore has to live in the parent (or in this component's
 * `activeId`), not in the panel's own subtree — unmounting a panel unmounts its
 * state with it. That is the single trap in this pattern and the reason the
 * demo's Search and Ask state is hoisted to `DemoPage`.
 */
export function Tabs({
  tabs,
  activeId,
  onChange,
  label,
  children,
}: {
  tabs: TabDef[];
  /** Controlled: the parent owns which tab is active and keeps its state. */
  activeId: string;
  onChange: (id: string) => void;
  label: string;
  /** `(tabId) => ReactNode` — rendered as that tab's panel. */
  children: (activeId: string) => ReactNode;
}) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function focusTab(index: number) {
    const next = ((index % tabs.length) + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    /* Focus synchronously. Every tab is already in the DOM — only its
      `tabindex` changes — so there is nothing to wait for, and deferring to
      `requestAnimationFrame` just loses the caret on the frame nobody awaits.
      Focusing a `tabindex="-1"` element programmatically is exactly what roving
      tabindex is for. Selected by data attribute rather than `#id`, so a tab id
      containing a character that needs `CSS.escape` cannot silently drop
      focus. */
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab="${target.id}"]`)
      ?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((t) => t.id === activeId);
    if (current < 0) return;

    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTab(current + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTab(current - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <>
      <div
        className="tablist"
        role="tablist"
        aria-label={label}
        ref={listRef}
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              data-tab={tab.id}
              className={`tab${selected ? " tab-active" : ""}`}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              /* Roving tabindex: the selected tab is the only tab stop. */
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.hint ? <span className="tab-hint">{tab.hint}</span> : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(activeId)}
        aria-labelledby={tabId(activeId)}
        tabIndex={0}
        className="tabpanel"
      >
        {children(activeId)}
      </div>
    </>
  );
}