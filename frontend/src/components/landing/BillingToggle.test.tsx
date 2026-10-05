/**
 * The billing toggle had three problems, and only one of them was visible in
 * the markup.
 *
 * It sat `inline-flex` at its section's left edge while the plan cards were
 * centred — measured 384px off-axis at 1440px, 208px at 768px. And its selected
 * state was `className="active"` plus a colour change on a read-only `<span>`,
 * which is a state that is invisible to anyone who cannot distinguish the two
 * greys. Both are fixed here; the centring is asserted from the stylesheet
 * because no DOM assertion can tell you where something ended up on screen.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BillingToggle } from "./BillingToggle";

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration block for a selector, comments stripped — the rules guarding
 * this carry long comments naming the properties they forbid, so an assertion
 * over raw text would be reading the comment. Same helper as
 * `tintedContrast.test.ts`. */
function rule(selector: string): string {
  // The selector is escaped: `:nth-child(even)` and `:not(.pro-cell)` contain
  // regex metacharacters, and interpolated raw the parens became capture groups
  // and the rule silently did not match.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
}

/** The bodies of every `@media <condition>` block, found by brace matching.

   A lazy `[\s\S]*?` cannot do this job: it will happily start at one media
   query's opening brace and scan on into a *different* block's body, which is
   how "the hint is revealed only at the narrow breakpoint" passed against a
   stylesheet where it was revealed at every breakpoint. Verified by
   re-introducing that defect and watching this fail.

   Every matching block is returned, because this file has several
   `(prefers-reduced-motion: reduce)` blocks. That is still safe: the callers'
   patterns are `\{[^}]*`-bounded, so a rule can only match within its own body,
   and only blocks carrying the condition asked about are in the string. */
function mediaBlocks(condition: string): string {
  const needle = `@media ${condition} {`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at < 0) break;
    let depth = 0;
    const open = css.indexOf("{", at);
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        bodies.push(css.slice(open, i));
        from = i;
        break;
      }
    }
  }
  return bodies.join("\n");
}

describe("BillingToggle", () => {
  it("reports the chosen period to its owner", async () => {
    const onChange = vi.fn();
    render(<BillingToggle annual={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole("switch", { name: /annual/i }));
    expect(onChange).toHaveBeenCalledWith(true);

    onChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /^monthly$/i }));
    expect(onChange).toHaveBeenCalledWith(false);

    onChange.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /^annual/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("marks the selected label as pressed, not merely as active", async () => {
    const { rerender } = render(<BillingToggle annual={false} onChange={vi.fn()} />);
    const monthly = screen.getByRole("button", { name: /^monthly$/i });
    const annual = screen.getByRole("button", { name: /^annual/i });

    // `aria-pressed` is what makes the state available to assistive tech at all;
    // the old markup had it on neither label.
    expect(monthly).toHaveAttribute("aria-pressed", "true");
    expect(annual).toHaveAttribute("aria-pressed", "false");

    rerender(<BillingToggle annual onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^monthly$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /^annual/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the switch and the two labels in step", () => {
    const { rerender } = render(<BillingToggle annual={false} onChange={vi.fn()} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    rerender(<BillingToggle annual onChange={vi.fn()} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("shows the saving on the annual label", () => {
    render(<BillingToggle annual={false} onChange={vi.fn()} />);
    expect(screen.getByText(/save 17%/i)).toBeInTheDocument();
  });

  it("gives both labels a visible focus ring", () => {
    // Keyboard users have to see which of the three controls they are on.
    expect(rule(".billing-toggle-label:focus-visible")).toMatch(/outline:\s*2px solid/);
    expect(rule(".toggle-switch:focus-visible")).toMatch(/outline:\s*2px solid/);
  });
});

describe("BillingToggle centring", () => {
  it("centres on the plan cards' axis, not the page's", () => {
    // `.billing-plans` is `max-width: 960px; margin: 0 auto`. The toggle row
    // carries the same measure so the control's midpoint is the midpoint of the
    // cards it switches — measured 0px off-axis at 1440/768 and 1px at 375.
    const row = rule(".billing-toggle-row");
    expect(row).toMatch(/justify-content:\s*center/);
    expect(row).toMatch(/max-width:\s*960px/);
    expect(row).toMatch(/margin:\s*0 auto/);
  });

  it("no longer anchors the control to the section's left edge", () => {
    // The old rule carried `margin: 0 0 28px` on an `inline-flex`, which sat it
    // flush against the section edge while the cards were centred. Its own
    // `display` is irrelevant now — as a flex item of `.billing-toggle-row` it
    // is centred by the row, and the margin is gone either way.
    expect(rule(".billing-toggle")).not.toMatch(/margin:/);
    expect(rule(".billing-toggle")).not.toMatch(/justify-self/);
  });

  it("conveys the selected state by shape and weight, not only colour", () => {
    const active = rule(".billing-toggle-label.active");
    // A pill is a shape; a heavier weight is a weight. Both survive greyscale.
    expect(active).toMatch(/background:/);
    expect(active).toMatch(/border-color:/);
    expect(active).toMatch(/font-weight:\s*800/);
    // The unselected label must not merely be "less colour" — it needs the
    // weight contrast to exist at all.
    expect(rule(".billing-toggle-label")).toMatch(/font-weight:\s*600/);
  });

  it("scopes the save badge to the toggle so the landing page cannot leak it", () => {
    // The badge was `.save-badge`, unscoped. Anything else that wanted a green
    // pill would have inherited it.
    expect(rule(".billing-toggle .save-badge")).toMatch(/color:\s*var\(--green-text\)/);
    expect(css).not.toMatch(/\n\.save-badge \{/);
  });

  it("respects reduced motion for the label transition", () => {
    const label = rule(".billing-toggle-label");
    expect(label).toMatch(/transition/);
    expect(
      mediaBlocks("(prefers-reduced-motion: reduce)"),
      "no prefers-reduced-motion rule for .billing-toggle-label",
    ).toMatch(/\.billing-toggle-label\s*\{[^}]*transition:\s*none/);
  });
});