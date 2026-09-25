import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Design-token integrity guard.
 *
 * A `var(--typo)` reference is not a build error and not a lint error — the
 * browser drops that one declaration and moves on. So a rule can look correct
 * in review while rendering as unstyled, and nothing in the normal test run
 * notices.
 *
 * That is not hypothetical. This check was written alongside the fix for four
 * dead declarations in App.css — `--panel`, `--foreground`, `--surface-alt`
 * (x2) and `--font-mono` — every one of which had been silently doing
 * nothing. Two of them were the reason the webhook event tags and the secret
 * box had no background at all.
 *
 * jsdom does not resolve custom properties from the real stylesheet, so this
 * reads the source text. That is the right level: the failure mode is textual
 * (a name matching nothing), not a computed-style question.
 */

// node:fs rather than Vite's `?raw` suffix: under this vitest config CSS
// imports are stubbed, so `?raw` resolves to an empty string. Reading from
// disk is why tsconfig.app.json includes the "node" types.
const css = ["App.css", "index.css"]
  .map((name) => readFileSync(resolve(process.cwd(), "src", name), "utf8"))
  .join("\n")
  // Comments quote the very tokens this test hunts for (e.g. "was
  // var(--panel)"), so they must be stripped before scanning or every fix
  // would re-trip the guard on its own explanation.
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("design tokens", () => {
  it("every referenced custom property is declared or has a fallback", () => {
    // matchAll groups are `string | undefined` under noUncheckedIndexedAccess;
    // group 1 always participates for these patterns, so assert it.
    const capture = (m: RegExpMatchArray): string => {
      const group = m[1];
      if (group === undefined) throw new Error(`no capture in ${m[0]}`);
      return group;
    };

    const declared = new Set(
      [...css.matchAll(/(--[\w-]+)\s*:/g)].map(capture),
    );
    const used = new Map<string, number>();
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*[,)]/g)) {
      const token = capture(m);
      used.set(token, (used.get(token) ?? 0) + 1);
    }

    const undefinedRefs: string[] = [];
    for (const [token, count] of used) {
      if (declared.has(token)) continue;
      // `var(--x, fallback)` is self-sufficient even when --x is undeclared.
      if (new RegExp(`var\\(\\s*${token}\\s*,`).test(css)) continue;
      undefinedRefs.push(`${token} (${count} use${count === 1 ? "" : "s"})`);
    }

    expect(undefinedRefs).toEqual([]);
  });

  it("restates the surface-ladder tokens in the dark theme block", () => {
    // The dark-theme surface rules lean on the --surface/--surface-2/--line
    // ladder and on --line-strong. A token defined only in :root resolves to
    // nothing under [data-theme="dark"], which is the "fine in light,
    // invisible in dark" failure this guards.
    const darkStart = css.indexOf(':root[data-theme="dark"] {');
    expect(darkStart).toBeGreaterThan(-1);
    const darkBlock = css.slice(darkStart);

    for (const token of [
      "--surface",
      "--surface-2",
      "--surface-3",
      "--line",
      "--line-strong",
      "--paper",
      "--ink",
    ]) {
      expect(darkBlock, `${token} must be redefined for dark theme`).toMatch(
        new RegExp(`${token}\\s*:`),
      );
    }
  });

  it("defines --line-strong once per theme", () => {
    // Two definitions: the light default and the dark override. If either
    // is dropped the card edges silently fall back to the hairline.
    expect(css.match(/--line-strong\s*:/g)).toHaveLength(2);
  });

  it("keeps the logo marquee keyframe in step with its copy count", () => {    // The marquee loops by translating a fixed percentage of a track that
    // holds N identical copies of the logo list. For the loop to be seamless
    // the percentage must be exactly one copy's width: 100/N. If the two drift
    // apart the strip wraps mid-copy and the row visibly jumps — the exact
    // "pops in from the right" bug this replaced, and one that renders fine
    // and lints fine, so nothing else in the suite notices.
    //
    // The old two-copy/-50% pairing was correct too, which is the trap: this
    // is a coupling guard, not a bug repro. Deriving the expected value from
    // the keyframe's own percentage keeps it honest for any copy count.
    const keyframe = css.match(
      /@keyframes\s+logo-scroll\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(keyframe, "@keyframes logo-scroll must exist").toBeDefined();

    const to = keyframe!.match(
      /to\s*\{[^}]*transform:\s*translateX\((-?[\d.]+)%\)/,
    )?.[1];
    expect(to, "logo-scroll must translateX by a percentage").toBeDefined();

    const percent = Number(to);
    // A percentage is a signed fraction of the track. 100/N => N = 100/pct.
    const copies = 100 / Math.abs(percent);

    // The tolerance here is loose on purpose. Writing -33.333333% instead of
    // -33.3% is a sub-pixel difference spread over a 42s cycle and is not a
    // bug worth failing a build over; the meaningful failure is a whole
    // *mismatch* (the "expected 3 to be 2" assertion below), not a rounding
    // difference. What is rejected here is a percentage that implies a
    // fractional number of copies, e.g. -40% -> 2.5.
    expect(
      Math.abs(copies - Math.round(copies)),
      `-${percent}% implies ${copies} copies, which is not a whole number`,
    ).toBeLessThan(0.05);

    // …and that whole number has to match the track that JSX actually builds,
    // which is the half of the coupling this file cannot see. Counting the
    // `...LOGOS` spreads is what makes this a real cross-check rather than a
    // restatement of the keyframe. This is the assertion that would have
    // caught a copy-count change made without its matching keyframe edit.
    const source = readFileSync(
      resolve(process.cwd(), "src", "pages", "LandingPage.tsx"),
      "utf8",
    );
    const strip = source.match(/\{(\[\.\.\.LOGOS[^\]]*\])\.map\(/)?.[1];
    expect(
      strip,
      "the logo strip must be built from ...LOGOS spreads",
    ).toBeDefined();
    const actual = (strip!.match(/\.\.\.LOGOS/g) ?? []).length;
    expect(
      actual,
      `keyframe implies ${Math.round(copies)} copies but the strip builds ${actual}`,
    ).toBe(Math.round(copies));
    expect(actual).toBeGreaterThanOrEqual(2);
  });

  it("gives each landing stat a distinct accent that dark mode can override", () => {
    // The stat figures read --card-accent, which is set by [data-accent] and
    // restated per theme by :root[data-theme="dark"] [data-accent]. Two failure
    // modes both end in three identical-looking numbers, and neither is caught
    // by a render test because a missing custom property silently falls back:
    //
    //   1. two stats sharing an accent, or
    //   2. an accent used here that no dark-theme block restates, so that one
    //      figure stays dark-mode-illegible while the other two lift.
    const source = readFileSync(
      resolve(process.cwd(), "src", "pages", "LandingPage.tsx"),
      "utf8",
    );
    const accents = [...source.matchAll(/stat-item"\s+data-accent="(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(accents).toHaveLength(3);
    // No repeats: a duplicated accent means two of the three figures match.
    expect(new Set(accents).size).toBe(3);

    for (const accent of accents) {
      // Scope each lookup to the *opening selector* of its own block. A naive
      // `[data-accent="green"]` search also matches inside
      // `:root[data-theme="dark"] [data-accent="green"]`, which let a broken
      // light-theme declaration pass by finding the dark one next to it.
      // The negative lookahead rejects a dark-prefixed occurrence, and
      // `{[^}]*` stops at the first closing brace so only that block's body
      // is considered.
      const body = (selector: string) => {
        const m = css.match(
          new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`),
        );
        return m?.[1] ?? "";
      };

      const light = body(`(?!:root)\\[data-accent="${accent}"\\]`);
      expect(
        light,
        `[data-accent="${accent}"] must declare --card-accent for the light theme`,
      ).toMatch(/--card-accent\s*:/);

      const dark = body(
        `:root\\[data-theme="dark"\\]\\s*\\[data-accent="${accent}"\\]`,
      );
      expect(
        dark,
        `[data-accent="${accent}"] must restate --card-accent for dark theme`,
      ).toMatch(/--card-accent\s*:/);
    }
  });

  it("gives the three stat figures equal tracks so they share one centre axis", () => {
    // Regression guard for the row reading as off-centre. This was a flex row
    // with `flex: 1 1 240px` on the children, and a flex item's automatic
    // minimum size (min-width: auto) floors it at its min-content width.
    // "12,000+" and "48,000+" are unbreakable tokens much wider than "99%", so
    // the outer items came out wider than the middle one and each figure's
    // centre landed on a different axis.
    //
    // Equal `minmax(0, 1fr)` tracks fix it. The 0 matters as much as the repeat:
    // a bare `1fr` is minmax(auto, 1fr) and reinstates the same min-content
    // floor, so the guard pins the zero rather than just counting columns.
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    const row = css.match(/\.stat-row\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(row, ".stat-row must still be styled").not.toBe("");
    expect(row, "stat figures must sit in equal, content-independent tracks").toMatch(
      /grid-template-columns:\s*repeat\(\s*3\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/,
    );
  });

  it("keeps the label selector off CountUp's own span", () => {
    // The label rule was `.stat-item span`, which also matches CountUp's
    // <span class="count-up"> — a *grandchild* of .stat-item, since it sits
    // inside <strong class="stat-value">. The number then inherited the label's
    // font-weight 600 and +0.01em tracking instead of the display 800 / -0.05em,
    // which is what read as the figure having lost its formatting.
    //
    // font-size and colour happened to survive (the .count-up rules outrank
    // this selector), so a render test would not catch a regression here.
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    expect(
      css,
      "label styling must not reach the animated number",
    ).toMatch(/\.stat-item\s*>\s*span\s*\{/);
    expect(
      css,
      "a bare `.stat-item span` re-couples the label to CountUp's span",
    ).not.toMatch(/\.stat-item\s+span\s*\{/);
  });

  it("never stacks the stat row, so the three figures stay comparable", () => {
    // Stacking turned one comparable set into three separate statements. The
    // old 720px rule forced `flex-basis: 100%` and rotated the dividers to
    // horizontal; on a grid row that declaration is inert, so its absence is
    // the real guarantee, and the vertical divider orientation proves the
    // rotation was not reintroduced under another breakpoint.
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    expect(
      css,
      "no breakpoint may force the stat items onto their own row",
    ).not.toMatch(/\.stat-item\s*\{[^}]*flex-basis:\s*100%/);
    const divider = css.match(/\.stat-item\s*\+\s*\.stat-item::before\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(divider, "the stat divider must still be styled").not.toBe("");
    expect(divider, "dividers stay vertical so the row needs no breakpoint").toMatch(
      /width:\s*1px/,
    );
  });
});
