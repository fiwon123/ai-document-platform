import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

const TABS = [
  { id: "search", label: "Search" },
  { id: "ask", label: "Ask" },
  { id: "export", label: "Export" },
];

/** A harness that owns the active tab, exactly as a real caller must. */
function Harness({ initial = "search" }: { initial?: string }) {
  const [activeId, setActiveId] = useState(initial);
  return (
    <Tabs tabs={TABS} activeId={activeId} onChange={setActiveId} label="Demo tools">
      {(id) => <p>panel for {id}</p>}
    </Tabs>
  );
}

const tabs = () => screen.getAllByRole("tab");
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

describe("Tabs", () => {
  it("exposes the tab pattern rather than just the tablist role", () => {
    render(<Harness />);

    // role="tablist" obliges these; a tablist without them fails
    // aria-required-children, which is why the carousel declined the role.
    expect(screen.getByRole("tablist", { name: "Demo tools" })).toBeTruthy();
    expect(tabs()).toHaveLength(3);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      screen.getByRole("tab", { name: /^Search/ }).id,
    );
    expect(screen.getByText("panel for search")).toBeTruthy();
    expect(screen.queryByText("panel for ask")).toBeNull();
  });

  it("marks exactly one tab selected and keeps only it in the tab order", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(tab("Search")).toHaveAttribute("aria-selected", "true");
    expect(tab("Ask")).toHaveAttribute("aria-selected", "false");
    // Roving tabindex: the tablist is one tab stop, not three.
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    await user.click(tab("Ask"));
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(screen.getByText("panel for ask")).toBeTruthy();
  });

  it("moves between tabs with the arrow keys, wrapping at both ends", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    tab("Search").focus();

    await user.keyboard("{ArrowRight}");
    expect(tab("Ask")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(tab("Export")).toHaveAttribute("aria-selected", "true");
    // Past the last tab: wrap to the first.
    await user.keyboard("{ArrowRight}");
    expect(tab("Search")).toHaveAttribute("aria-selected", "true");
    // Before the first tab: wrap to the last.
    await user.keyboard("{ArrowLeft}");
    expect(tab("Export")).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the first and last tab with Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    tab("Search").focus();
    await user.keyboard("{End}");
    expect(tab("Export")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("Search")).toHaveAttribute("aria-selected", "true");
  });

  it("moves DOM focus with the selection, so arrow keys feel connected", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    tab("Search").focus();
    await user.keyboard("{ArrowRight}");
    // Selection following focus is the point: focus must not stay behind on the
    // tab the user just arrowed away from, or a second ArrowRight does nothing
    // visible.
    expect(tab("Ask")).toHaveFocus();
  });

  it("ignores keys it does not own, so typing in a panel is unaffected", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    tab("Search").focus();
    await user.keyboard("{ArrowDown}a");
    expect(tab("Search")).toHaveAttribute("aria-selected", "true");
  });

  it("honours an initial tab other than the first", () => {
    render(<Harness initial="ask" />);
    expect(tab("Ask")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("panel for ask")).toBeTruthy();
  });
});
