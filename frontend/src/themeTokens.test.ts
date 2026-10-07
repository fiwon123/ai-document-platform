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

/** Body of a top-level rule, e.g. `:root` or `:root[data-theme="dark"]`. */
const ruleBody = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`no ${selector} block in the stylesheet`);
  return m[1];
};

/** A single custom property's declared value. */
const token = (body: string, name: string): string => {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared in this block`);
  return m[1].trim();
};

describe("design tokens", () => {
  it("every referenced custom property is declared or has a fallback", () => {
    // matchAll groups are `string | undefined` under noUncheckedIndexedAccess;
    // group 1 always participates for these patterns, so assert it.
    const capture = (m: RegExpMatchArray): string => {
      const group = m[1];
      if (group === undefined) throw new Error(`no capture in ${m[0]}`);
      return group;
    };

    const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(capture));
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
    // Three definitions: the light default, the dark override, and the
    // forced-dark restate (see the .forced-dark section at the end of
    // App.css). If any is dropped the card edges silently fall back to the
    // hairline.
    expect(css.match(/--line-strong\s*:/g)).toHaveLength(3);
  });

  it("forced-dark restates every dark-theme token with the same value", () => {
    // .forced-dark pins a subtree to the dark aesthetic in BOTH themes by
    // re-declaring the dark blocks' tokens (the section at the end of
    // App.css). The values are copies — CSS custom properties resolve where
    // they are used, so there is no way to alias another scope's declaration —
    // which means the two lists can drift: someone restyles the dark theme
    // and forgets the copy, and every pinned surface keeps the OLD dark value
    // while everything around it moves on. No render test can see that,
    // because both values are "dark-looking"; only a name+value comparison
    // against the real dark blocks catches it, in either direction (a token
    // dropped from forced-dark, or one invented there that dark never had).
    const darkBodies = [
      ...css.matchAll(/(?:^|[}\n])\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/g),
    ].map((m) => m[1] ?? "");
    // Four today: App.css's surface ladder, the badge colours, --error-text,
    // and index.css's type/shadow tokens. A regex that matched nothing would
    // make the loops below vacuous, so pin the floor.
    expect(darkBodies.length).toBeGreaterThanOrEqual(4);

    const parse = (body: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        // Values may wrap across lines differently in the two blocks
        // (prettier line-width), so compare on normalised whitespace.
        out.set(m[1] ?? "", (m[2] ?? "").replace(/\s+/g, " ").trim());
      }
      return out;
    };

    const dark = new Map<string, string>();
    for (const body of darkBodies) {
      for (const [name, value] of parse(body)) dark.set(name, value);
    }
    expect(dark.size, "the dark blocks must declare tokens").toBeGreaterThan(40);

    const forced = parse(ruleBody("\\.forced-dark"));

    for (const [name, value] of dark) {
      expect(
        forced.get(name),
        `forced-dark must restate ${name} exactly as the dark theme declares it`,
      ).toBe(value);
    }
    for (const name of forced.keys()) {
      expect(dark.has(name), `forced-dark declares ${name}, which no dark-theme block does`).toBe(
        true,
      );
    }
  });

  it("keeps the logo marquee keyframe in step with its copy count", () => {
    // The marquee loops by translating a fixed percentage of a track that
    // holds N identical copies of the logo list. For the loop to be seamless
    // the percentage must be exactly one copy's width: 100/N. If the two drift
    // apart the strip wraps mid-copy and the row visibly jumps — the exact
    // "pops in from the right" bug this replaced, and one that renders fine
    // and lints fine, so nothing else in the suite notices.
    //
    // The old two-copy/-50% pairing was correct too, which is the trap: this
    // is a coupling guard, not a bug repro. Deriving the expected value from
    // the keyframe's own percentage keeps it honest for any copy count.
    const keyframe = css.match(/@keyframes\s+logo-scroll\s*\{[\s\S]*?\n\}/)?.[0];
    expect(keyframe, "@keyframes logo-scroll must exist").toBeDefined();

    const to = keyframe!.match(/to\s*\{[^}]*transform:\s*translateX\((-?[\d.]+)%\)/)?.[1];
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
    const source = readFileSync(resolve(process.cwd(), "src", "pages", "LandingPage.tsx"), "utf8");
    const strip = source.match(/\{(\[\.\.\.LOGOS[^\]]*\])\.map\(/)?.[1];
    expect(strip, "the logo strip must be built from ...LOGOS spreads").toBeDefined();
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
    const source = readFileSync(resolve(process.cwd(), "src", "pages", "LandingPage.tsx"), "utf8");
    const accents = [...source.matchAll(/stat-item"\s+data-accent="(\w+)"/g)].map((m) => m[1]);
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
        const m = css.match(new RegExp(`(?:^|[}\\n])\\s*${selector}\\s*\\{([^}]*)\\}`));
        return m?.[1] ?? "";
      };

      const light = body(`(?!:root)\\[data-accent="${accent}"\\]`);
      expect(
        light,
        `[data-accent="${accent}"] must declare --card-accent for the light theme`,
      ).toMatch(/--card-accent\s*:/);

      const dark = body(`:root\\[data-theme="dark"\\]\\s*\\[data-accent="${accent}"\\]`);
      expect(dark, `[data-accent="${accent}"] must restate --card-accent for dark theme`).toMatch(
        /--card-accent\s*:/,
      );
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
    expect(css, "label styling must not reach the animated number").toMatch(
      /\.stat-item\s*>\s*span\s*\{/,
    );
    expect(css, "a bare `.stat-item span` re-couples the label to CountUp's span").not.toMatch(
      /\.stat-item\s+span\s*\{/,
    );
  });

  it("never stacks the stat row, so the three figures stay comparable", () => {
    // Stacking turned one comparable set into three separate statements. The
    // old 720px rule forced `flex-basis: 100%` and rotated the dividers to
    // horizontal; on a grid row that declaration is inert, so its absence is
    // the real guarantee, and the vertical divider orientation proves the
    // rotation was not reintroduced under another breakpoint.
    const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");
    expect(css, "no breakpoint may force the stat items onto their own row").not.toMatch(
      /\.stat-item\s*\{[^}]*flex-basis:\s*100%/,
    );
    const divider = css.match(/\.stat-item\s*\+\s*\.stat-item::before\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(divider, "the stat divider must still be styled").not.toBe("");
    expect(divider, "dividers stay vertical so the row needs no breakpoint").toMatch(
      /width:\s*1px/,
    );
  });

  it("keeps small text on tinted chips and inverted bars above 4.5:1 in both themes", () => {
    // Three labels failed WCAG AA as text: the green eyebrow and the plan
    // "Save" badge (--green on --green-soft, 3.15:1 in light) and the preview
    // URL chip (--muted on the bar, 2.16:1 light).
    //
    // The assertions compute the ratio from the values actually in the
    // stylesheet, so a *passing* recolour does not have to be pinned to a hex:
    // only falling back under the threshold fails. A pinned-hex test would be
    // satisfied by the colour it was written against and would break on any
    // legitimate darkening, which is the opposite of what this guard is for.
    //
    // The two backgrounds are composites, so they are modelled rather than
    // hardcoded. The chip is --green-soft over the page; the bar paints --ink
    // with a 16% --paper wash (the color-mix in the .preview-url rule). The
    // model reproduces the colours Chrome actually reports — #f0fdf4 /
    // #142e2e for the chip and #353c4c / #c1c7d0 for the bar — so a failure
    // here means a real failure, not a modelling artefact.
    type Rgb = { r: number; g: number; b: number; a: number };
    const parse = (raw: string): Rgb => {
      const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: 1,
        };
      }
      const fn = raw.match(/^rgba?\(([^)]+)\)$/);
      if (fn) {
        const parts = fn[1]!
          .split(/[\s/]+/)
          .filter(Boolean)
          .map(Number);
        return {
          r: parts[0] ?? 0,
          g: parts[1] ?? 0,
          b: parts[2] ?? 0,
          a: parts[3] ?? 1,
        };
      }
      throw new Error(`unsupported colour syntax: ${raw}`);
    };
    const over = (fg: Rgb, bg: Rgb): Rgb => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const luminance = ({ r, g, b }: Rgb): number => {
      const channel = (v: number): number => {
        const n = v / 255;
        return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a: Rgb, b: Rgb): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const { name, body } of [
      { name: "light", body: ruleBody(":root") },
      { name: "dark", body: ruleBody(':root\\[data-theme="dark"\\]') },
    ]) {
      const page = parse(token(body, "--paper"));

      // Green chip: --green-text on --green-soft over the page.
      const chipBg = over(parse(token(body, "--green-soft")), page);
      const greenText = contrast(parse(token(body, "--green-text")), chipBg);
      expect(
        greenText,
        `--green-text on --green-soft in the ${name} theme is ${greenText.toFixed(2)}:1, under AA's 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);

      // Preview bar: --on-ink-muted on var(--ink) with a 16% --paper wash.
      const barBg = over(
        { ...parse(token(body, "--paper")), a: 0.16 },
        parse(token(body, "--ink")),
      );
      const barText = contrast(parse(token(body, "--on-ink-muted")), barBg);
      expect(
        barText,
        `--on-ink-muted on the preview bar in the ${name} theme is ${barText.toFixed(2)}:1, under AA's 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps --muted readable on the page and panel backgrounds", () => {
    // --muted was deliberately tuned to clear 4.5:1 on both --paper and
    // --surface, and that is exactly why the preview-bar labels needed their
    // own token instead of a global darkening: the bar paints var(--ink),
    // which inverts per theme, and a value that works there cannot also work
    // here. This guards the token against being "fixed" for the bar and
    // pushed under AA everywhere else.
    const light = ruleBody(":root");
    const hex = (name: string): string => {
      const m = light.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
      if (!m?.[1]) throw new Error(`${name} must be a hex colour`);
      return m[1];
    };
    const relLuminance = (hexValue: string): number => {
      const h = hexValue.replace("#", "");
      const channel = (i: number): number => {
        const n = parseInt(h.slice(i, i + 2), 16) / 255;
        return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const surface of ["--paper", "--surface"]) {
      const value = ratio(hex("--muted"), hex(surface));
      expect(
        value,
        `--muted on ${surface} is ${value.toFixed(2)}:1, under AA's 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
