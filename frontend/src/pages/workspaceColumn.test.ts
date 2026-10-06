import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The workspace column (#588).
 *
 * `/app/settings` and `/app/webhooks` both sat hard against the left edge of a
 * 1200px shell while their own content was 640px wide — measured at 1440px:
 * 474px of dead space to the right of the card and nothing balancing it. The
 * two routes shared `.page` and `.settings-card`, so the defect was shared too,
 * and any *new* narrow workspace page would inherit it by writing
 * `className="page"`.
 *
 * These assertions are about the shared mechanism rather than either page, so
 * the next page to need a narrow column gets it by adding a class instead of
 * rediscovering the gap.
 */
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/* Whitespace in a selector is not significant to CSS but it is to a regex:
   `.page-column,\n.page-column--wide` is written across two lines. */
const ruleBody = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

const decl = (body: string, prop: string): string | undefined =>
  body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`))?.[1]?.trim();

const px = (value: string | undefined): number => Number.parseFloat(value ?? "");

describe("workspace column", () => {
  it("centres the column instead of letting it hug the shell's left edge", () => {
    /* `margin-inline: auto` is the fix; `margin: 0 auto` would also centre but
       resets the vertical margin the page header relies on. */
    expect(decl(ruleBody(".page-column"), "margin-inline")).toBe("auto");
  });

  it("uses a constant measure rather than a percentage of the shell", () => {
    /* A percentage would track `.main-content`'s 1200px and re-widen the column
       on a larger viewport, which is the shape of bug #588 reports. */
    const width = decl(ruleBody(".page-column"), "max-width");
    expect(width).toBeTruthy();
    expect(width).not.toContain("%");
    expect(px(width)).toBeGreaterThanOrEqual(680);
    expect(px(width)).toBeLessThanOrEqual(760);
  });

  it("gives card lists more room than a single form column", () => {
    /* A webhook card carries a URL, an event tag row, a three-item definition
       list and a button row; at the form width the URL wrapped to three lines. */
    const narrow = px(decl(ruleBody(".page-column"), "max-width"));
    const wide = px(decl(ruleBody(".page-column--wide"), "max-width"));
    expect(wide).toBeGreaterThan(narrow);
  });

  it("lets a card fill the column rather than capping at its old 640px", () => {
    /* Without this the column centres but each card still sits 640px wide with
       the slack pushed to the right — the same left-hug one level down. */
    expect(decl(ruleBody(".page-column .settings-card"), "max-width")).toBe("none");
  });

  it("applies the column to both routes it was written for", () => {
    /* Read from the pages rather than asserted in each page's own test, because
       the failure this guards against is one route keeping the class and the
       other dropping it — invisible in a single-file test. */
    for (const file of ["SettingsPage.tsx", "WebhooksPage.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src", "pages", file), "utf8");
      expect(source, file).toMatch(/className="page page-column/);
    }
    /* Webhooks additionally takes the wider variant. */
    expect(
      readFileSync(resolve(process.cwd(), "src", "pages", "WebhooksPage.tsx"), "utf8"),
    ).toMatch(/className="page page-column page-column--wide"/);
  });

  it("does not constrain the routes that genuinely want the full shell", () => {
    /* Documents, Search, Dashboard and Admin are grids and tables: capping
       their width would be a regression, so the column must stay opt-in via
       the extra class rather than becoming `.page`'s own rule. */
    expect(css).not.toMatch(/^\s*\.page\s*\{[^}]*max-width/m);
  });
});
