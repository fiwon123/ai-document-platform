import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Marketing measure guard (#440).
 *
 * The 13 interior marketing routes rendered inside a 900px `.page-body`, which
 * is 46.9% of a 1920px viewport — the "pages are too small on a PC" report. The
 * workspace (`.main-content`) was already 1200px, so marketing was the narrow
 * thing on a large monitor.
 *
 * Widening the container is the easy half. The trap is the interaction with the
 * reading measure, and it is not obvious from the stylesheet:
 *
 *   - `.page-body` is `box-sizing: border-box`, so `max-width` is the WHOLE box
 *     and the `6vw` gutter is inside it. 900px meant 670px of content, not 900.
 *   - `ch` is the width of the "0" glyph, not of an average character. Measured
 *     in Manrope at 16px, 1ch = 10.0px while the average character in running
 *     prose is 7.37px, so **1ch ~= 1.36 real characters**. The intuitive
 *     "70 characters" expressed as `70ch` resolves to 700px ~= 94 characters,
 *     i.e. *wider* than the 670px it was supposed to protect.
 *
 * So the invariants pinned here are the relationships, not the literals. A
 * deliberate retune to 1240px must not fail this file; what must fail is
 * marketing going narrower than the workspace, the container measure being
 * declared twice, and prose and lists disagreeing with each other.
 *
 * ## The reading measure was deliberately removed (#621)
 *
 * This file used to require a 45–75 character reading measure on `.page-body p`
 * and `.legal-body`. That cap was deleted, and the owner confirmed the wider
 * prose is intended rather than accidental — so the requirement is inverted
 * rather than reinstated.
 *
 * What replaced it is the invariant that would have caught the removal being
 * half-finished: the cap came off `.page-body p` and `.legal-body` but stayed on
 * `.page-body ul, .page-body ol`, leaving prose at ~127 characters per line beside
 * ~55-character bullets on every page that has a list. "Prose and lists declare
 * the same measure" holds in both directions — capped or uncapped — and is the
 * check that fails if a future edit reaches only half the rules it names.
 *
 * A cap narrower than the container is still a defect, so that is asserted
 * directly rather than through a character budget.
 */

const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const ruleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

/** Every declaration of `name` for `selector`, including inside media queries. */
const allDeclarationsFor = (selector: string, name: string): string[] =>
  [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g"))]
    .flatMap((m) => [...(m[1] ?? "").matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))])
    .map((m) => (m[1] ?? "").trim());

const declaration = (selector: string, name: string): string => {
  const m = ruleBody(selector).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared on ${selector}`);
  return m[1].trim();
};

const px = (value: string): number => {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) throw new Error(`not a px value: ${value}`);
  return n;
};

const ch = (value: string): number => {
  const m = value.match(/^([\d.]+)ch$/);
  if (!m?.[1]) throw new Error(`not a ch value: ${value}`);
  return Number.parseFloat(m[1]);
};

/** Pixels in one `ch` in Manrope at 16px. Measured in Chromium, not assumed —
 *  the character-budget assertions that used to need `CH_TO_CHARACTERS` are gone
 *  (#621), but a declared `ch` measure still has to be compared against a px
 *  container, and that comparison needs the real width of a `ch`. */
const CH_PX = 10.0;

/* ── Absence-aware helpers (#621) ───────────────────────────────────────────
   The prose measure is now intentionally *undeclared*, so "no max-width" is a
   meaningful state rather than a missing value. `declaration()` throws on it,
   which is right for the container (which must exist) and wrong for the
   measures that are allowed to be absent. These return `null` instead, and
   `measurePx` reads `null` and `"none"` as "fills the container". */

/** Like `ruleBody`, but a missing rule is `null` rather than an error. */
const maybeRuleBody = (selector: string): string | null => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? null;
};

/** Like `groupedRuleBody`, but a missing rule is `null` rather than an error. */
const maybeGroupedRuleBody = (selector: string): string | null => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*,\\s*[^{}]*\\{([^}]*)\\}`));
  return m?.[1] ?? null;
};

const maybeDeclaration = (body: string | null, name: string): string | null =>
  body?.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? null;

/**
 * A declared measure in pixels. An absent measure — or an explicit `none` —
 * resolves to `containerPx`, because that is what it means: the element fills
 * its container rather than being capped inside it.
 */
const measurePx = (value: string | null, containerPx: number): number => {
  if (value === null || value === "none") return containerPx;
  if (value.endsWith("ch")) return ch(value) * CH_PX;
  return px(value);
};

describe("marketing measure (#440)", () => {
  it("renders the marketing body at least as wide as the workspace", () => {
    const marketing = px(declaration(".page-body", "max-width"));
    const workspace = px(declaration(".main-content", "max-width"));

    // The bug was marketing at 900px under a 1200px workspace. Directional, so
    // an intentional change to either side is allowed; a regression is not.
    expect(marketing).toBeGreaterThanOrEqual(workspace);
  });

  it("declares the marketing measure exactly once, with no later override", () => {
    // A second `.page-body` rule is how a breakpoint or a later refactor would
    // quietly put the old narrow value back. Count declarations, not rules.
    expect(allDeclarationsFor(".page-body", "max-width")).toHaveLength(1);
  });

  it("lets prose fill the marketing container", () => {
    const container = px(declaration(".page-body", "max-width"));
    const prose = maybeDeclaration(maybeRuleBody(".page-body p"), "max-width");

    // Deliberately not a character budget. The 45–75 measure was removed on
    // purpose (#621), so pinning a number here would just re-litigate it. What
    // must not come back is a cap that strands prose inside the container.
    expect(measurePx(prose, container)).toBeGreaterThanOrEqual(container);
  });

  it("keeps lists on the same measure as paragraphs", () => {
    const paragraph = maybeDeclaration(maybeRuleBody(".page-body p"), "max-width");
    // `.page-body ul, .page-body ol` is a grouped rule.
    const list = maybeDeclaration(maybeGroupedRuleBody(".page-body ul"), "max-width");

    // This is the check that would have caught #621. The cap came off the
    // paragraphs and stayed on the lists, so prose ran 127 characters to the
    // line while bullets sat in a 515px column — and every other assertion in
    // this file passed, because each looked at one selector at a time.
    expect(list).toBe(paragraph);
  });

  it("never strands prose or lists in a measure narrower than the container", () => {
    const container = px(declaration(".page-body", "max-width"));

    for (const body of [maybeRuleBody(".page-body p"), maybeGroupedRuleBody(".page-body ul")]) {
      const value = maybeDeclaration(body, "max-width");
      expect(measurePx(value, container), `measure ${value ?? "(unset)"}`).toBeGreaterThanOrEqual(
        container,
      );
    }
  });

  it("does not give the pipeline a narrower list measure than other prose", () => {
    // #582 scoped this override so the pipeline could opt out of the prose list
    // cap. With the cap gone it reads `max-width: none`, which now matches every
    // other list — so the invariant is that it has not become a way to make this
    // one list narrower than the prose around it.
    const container = px(declaration(".page-body", "max-width"));
    const other = maybeDeclaration(maybeGroupedRuleBody(".page-body ul"), "max-width");
    const pipeline = maybeDeclaration(maybeRuleBody("\\.page-body ol\\.pipeline"), "max-width");

    expect(measurePx(pipeline, container)).toBeGreaterThanOrEqual(measurePx(other, container));
  });

  it("caps the pipeline cards at one measure, so the border has no dead interior", () => {
    // The reason the list-width override above is safe. Widening the cards alone
    // recreates the defect #554 measured on /careers: a bordered box much wider
    // than the prose inside it. An earlier attempt answered that with a
    // two-column grid, which does not work on this page — `.page-body p` and
    // `.page-body ul` cap at 52ch, so measured inside a 927px card content box
    // the detail resolves to 468px, the outcome to 468px and the chips to 520px.
    // A 927px row holds exactly one column of prose and then ~400px of nothing,
    // so every two-lane arrangement starved one lane (the lead column measured
    // 79% empty; moving the chips into it made them wrap to three rows and left
    // 147px blank under the detail instead).
    //
    // So the invariant is the card's own cap: one measure wide, no more.
    expect(declaration(".pipeline-stage", "max-width")).toBeDefined();

    // And the widest child must actually fit inside it, or the chips wrap and
    // the card grows a ragged third row. 600px - 28px - 26px padding - 2px
    // border = 544px of content against a 520px chip row.
    const card = declaration(".pipeline-stage", "max-width")!.replace(/px$/, "");
    const content = Number(card) - 28 - 26 - 2;
    expect(content).toBeGreaterThanOrEqual(520);

    // No grid columns anywhere in the pipeline: a second lane is exactly the
    // thing that cannot be filled, so its absence is the invariant now.
    expect(ruleBody("\\.pipeline-stage-inner")).toMatch(/display\s*:\s*grid/);
    expect(css).not.toMatch(
      /@media\s*\(min-width:\s*900px\)[\s\S]*?\.pipeline-stage-inner\s*\{[\s\S]*?grid-template-columns/,
    );
  });

  it("keeps the legal body on the same measure as its paragraphs", () => {
    // The legal pages are the prose-heaviest on the site. They previously
    // declared their own `.legal-body { max-width: 55ch }` so that every
    // `.legal-section h2` stayed flush with the text it heads; capping only the
    // `<p>`s would have left each heading spanning the full container while its
    // own paragraph stopped short. Both caps went in #621, so the invariant is
    // that the legal body and ordinary prose still resolve to the same box.
    const container = px(declaration(".page-body", "max-width"));
    const legal = maybeDeclaration(maybeRuleBody(".legal-body"), "max-width");
    const prose = maybeDeclaration(maybeRuleBody(".page-body p"), "max-width");

    expect(measurePx(legal, container)).toBe(measurePx(prose, container));
  });

  it("keeps the CTA band's own 54ch measure out of the prose rule's reach", () => {
    // `.page-body p` is (0,1,1) and an unscoped `.page-cta-band-sub` is
    // (0,1,0), so the prose cap silently wins on specificity. The band is
    // centred text, not a reading measure, and is scoped to opt out.
    expect(css).toMatch(/\.page-body \.page-cta-band-sub\s*\{/);
    const bandSub = declaration(".page-body .page-cta-band-sub", "max-width");
    expect(bandSub).toBe("54ch");
  });

  it("gives the hero a measure of its own that is not the paragraph measure", () => {
    // The hero headline is `clamp(..., 3.4rem)`; at 780px it was stranded in a
    // narrow column. Guard that it stays a real width rather than reverting.
    const hero = px(declaration(".page-hero-inner", "max-width"));
    expect(hero).toBeGreaterThanOrEqual(780);
  });
});
