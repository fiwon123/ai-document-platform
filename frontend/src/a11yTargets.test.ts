import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.5.8 Target Size (Minimum) — the 24x24 CSS px floor.
 *
 * These fixes are pure CSS, and jsdom has no layout engine: a test that rendered
 * `TermsPage` and measured the label would read 0px for everything and pass
 * forever. So instead of measuring, this pins the declaration that makes the
 * measurement true. Drop a `min-height` from App.css and this fails; keep it
 * and the live sweep in #459's acceptance criteria is the thing that verifies
 * the rendered result (156 loads, 0 violations).
 *
 * The file is located by walking up from the working directory rather than via
 * `import.meta.url`, which is not a file: URL under vitest's jsdom environment.
 */
function findAppCss(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "src/App.css");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("could not locate src/App.css");
}

const css = readFileSync(findAppCss(), "utf8");

/** CSS with every `/* ... *\/` comment removed, so prose about `::after` or
 *  "inline exception" is never mistaken for a declaration. */
const declarationsOnly = css.replace(/\/\*[\s\S]*?\*\//g, "");

function ruleFor(source: string, selector: string): { body: string; lead: string } {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^[^{}]*|\\})\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m");
  const match = pattern.exec(source);
  const [, head, body] = match ?? [];
  if (body === undefined) throw new Error(`no rule found for ${selector}`);
  // Everything from the end of the previous rule up to this one's brace is the
  // comment that introduces it, when there is one.
  const lead = (head ?? "").slice((head ?? "").lastIndexOf("}") + 1);
  return { body, lead };
}

/** Body of the first rule block whose selector list contains `selector`. */
function ruleBody(selector: string): string {
  return ruleFor(declarationsOnly, selector).body;
}

/** The comment immediately preceding the rule, comments included. */
function ruleComment(selector: string): string {
  return ruleFor(css, selector).lead;
}

/** The smallest min-height any rule for `selector` declares, in px. */
function minHeight(selector: string): number {
  const values = [
    ...declarationsOnly.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
  ]
    .map((m) => declarationsOnly.slice(m.index))
    .map((region) => /\{([^}]*)\}/.exec(region)?.[1] ?? "")
    .flatMap((body) =>
      [...body.matchAll(/min-height:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])),
    );
  return values.length ? Math.min(...values) : 0;
}

// Every standalone control the #459 sweep found under 24px, with the live
// measurement that motivated it. `own` is the element's own box; `via` is the
// effective target when that is a wrapping <label> rather than the input.
const FIXED: Array<{ selector: string; was: string; via?: string }> = [
  { selector: ".navbar-username", was: "111x23.2", via: "self" },
  { selector: ".demo-back-home", was: "90x23.2", via: "self" },
  { selector: ".form-group label", was: "392x23.2", via: "self" },
  { selector: ".qa-model-label", was: "41x23.2", via: "self" },
  { selector: ".terms-label", was: "354x20", via: "self" },
  { selector: ".webhook-event-option", was: "138-153x23.2", via: "self" },
];

describe("WCAG 2.5.8 target size floor", () => {
  it.each(FIXED)("$selector carries a 24px min-height (was $was)", ({ selector }) => {
    expect(minHeight(selector)).toBeGreaterThanOrEqual(24);
  });

  // The checkbox inputs are deliberately still small — the target is the label
  // wrapping them, which is the whole row. If someone "fixed" this by inflating
  // the input instead, the row would be the wrong thing to grow.
  it.each([".terms-label input", ".webhook-event-option input"])(
    "%s is not inflated; the label is the target",
    (selector) => {
      const body = ruleBody(selector);
      expect(body).not.toMatch(/min-height:\s*(?:2[4-9]|[3-9]\d)px/);
      const explicit = /\b(?:width|height):\s*(\d+(?:\.\d+)?)px/g;
      for (const m of body.matchAll(explicit)) {
        expect(Number(m[1])).toBeLessThan(24);
      }
    },
  );

  // Growth must be on the element itself. A positioned ::after or ::before
  // would widen the clickable area while the bounding box — the thing both the
  // audit and the spec talk about — stayed small.
  it.each(FIXED)("$selector grows via the element, not a pseudo-element", ({ selector }) => {
    const body = ruleBody(selector);
    expect(body).toMatch(/min-height:\s*24px/);
    expect(body).not.toMatch(/::(before|after)/);
  });

  // The inline exception is only defensible while it is written down: these
  // links sit in a sentence, so 2.5.8 excuses their size. If someone removes
  // the note, the next reader has no idea 151 sub-24px targets were deliberate.
  it("documents the inline exception where it is claimed", () => {
    expect(ruleComment(".page-body a:not(.btn)")).toMatch(/inline exception/i);
    expect(ruleComment(".auth-footer a")).toMatch(/inline\s+exception/i);
  });
});
