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
    // Two definitions: the light default and the dark override. If either is
    // dropped the card edges silently fall back to the hairline.
    expect(css.match(/--line-strong\s*:/g)).toHaveLength(2);
  });
});
