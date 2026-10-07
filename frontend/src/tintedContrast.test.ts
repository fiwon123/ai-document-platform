import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contrast guard for tinted fills and tinted text.
 *
 * The defects this covers were invisible in review: every rule read like a
 * sensible pair of values, and each only failed once a browser composited it.
 * Two shapes of mistake, both of them "the token is right for its own job and
 * wrong for this one":
 *
 *   - a **foreground** step used as a **fill**. `--card-accent` is deliberately
 *     bright in dark mode (blue-400), so the step-number circles painted
 *     #60a5fa under a white numeral: 2.54:1 in light and 1.67:1 for amber in
 *     dark. A dark-mode override had then flipped the numeral to dark ink to
 *     compensate, which was correct for a bright fill and exactly wrong once
 *     the fill was pinned dark.
 *   - a **fill** step used as **text**. `--success`/`--danger` are 600-level
 *     fills; as 11px text on a 15% tint of themselves they measured 2.67:1
 *     (light) and 3.79:1 (dark). The sheet already had `--green-text` and
 *     `--danger-text` for precisely this, and these rules skipped them.
 *
 * jsdom does not resolve custom properties from the real stylesheet, so this
 * reads the source and does the WCAG arithmetic itself — the same approach as
 * `appBarContrast.test.ts`. `mix()` reproduces `color-mix(in srgb, …)`, and it
 * is faithful rather than approximate: 12% of blue-600 over `--surface-2`
 * computes to rgb(203, 216, 239), which is the pixel the browser actually
 * painted. Where a tint is composited over a panel, the test uses the theme's
 * lighter panel so the arithmetic is the worst case, not the flattering one.
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

const token = (body: string, name: string): string => {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`${name} is not declared in this block`);
  return m[1].trim();
};

const hasToken = (body: string, name: string): boolean => new RegExp(`${name}\\s*:`).test(body);

const light = ruleBody(":root");
const dark = ruleBody(':root\\[data-theme\\="dark"\\]');

/**
 * A custom property is inherited, so a dark-theme lookup falls back to `:root`.
 * `--success` is declared only there — it is a fill step that both themes share
 * — and reading the dark block alone would throw rather than report the value
 * the browser actually uses.
 */
const themed = (theme: "light" | "dark", name: string): string =>
  token(theme === "dark" && hasToken(dark, name) ? dark : light, name);

/** `#rgb`, `#rrggbb` or `rgb(r g b / a)` -> [r,g,b]. */
const parseColor = (value: string): [number, number, number] => {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const nums = value.match(/[\d.]+/g);
  if (nums && nums.length >= 3) {
    return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
  }
  throw new Error(`cannot parse colour: ${value}`);
};

/** WCAG 2.1 relative luminance. */
const luminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string): number => {
  const sorted = [luminance(parseColor(a)), luminance(parseColor(b))].sort((x, y) => y - x);
  const hi = sorted[0];
  const lo = sorted[1];
  if (hi === undefined || lo === undefined) {
    throw new Error(`cannot order luminances for ${a} / ${b}`);
  }
  return (hi + 0.05) / (lo + 0.05);
};

/** `color-mix(in srgb, over pct%, under)`, which is what these tints use. */
const mix = (over: string, pct: number, under: string): string => {
  const a = parseColor(over);
  const b = parseColor(under);
  const p = pct / 100;
  return `rgb(${a.map((v, i) => Math.round(v * p + (b[i] ?? 0) * (1 - p))).join(" ")})`;
};

/** The alpha of a `rgb(r g b / a)` declaration, or 1 for an opaque colour. */
const alphaOf = (value: string): number => Number(value.match(/\/\s*([\d.]+)\s*\)/)?.[1] ?? "1");

const white = "#ffffff";
const ACCENTS = ["blue", "violet", "green", "amber", "rose"] as const;

describe("accent step-number badges", () => {
  it("gives every accent a solid fill that clears AA under white text", () => {
    // --card-accent cannot do this job: it is a foreground step, so it climbs
    // to blue-400/green-400 in dark mode, where white on it is 2.54:1 and 1.74:1.
    for (const accent of ACCENTS) {
      const body = ruleBody(`\\[data-accent="${accent}"\\]`);
      const solid = token(body, "--card-accent-solid");
      const ratio = contrast(white, solid);
      expect(
        ratio,
        `${accent} solid fill ${solid} is ${ratio.toFixed(2)}:1 under white, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the solid fill out of the dark accent blocks", () => {
    // The invariant that makes the numeral white in both themes: if a dark
    // block re-declared the solid fill it would drift light and reintroduce the
    // 1.67:1 amber. Only --card-accent is allowed to change with the theme.
    for (const accent of ACCENTS) {
      const body = ruleBody(`:root\\[data-theme="dark"\\] \\[data-accent="${accent}"\\]`);
      expect(
        hasToken(body, "--card-accent-solid"),
        `dark ${accent} block re-declares the solid fill`,
      ).toBe(false);
    }
  });

  it("paints the badges with the solid fill, not the foreground step", () => {
    // .pipeline-outcome-label joined this list in #582: the white "YOU GET" pill
    // painted --card-accent, which measured 1.67:1 (amber) to 2.72:1 (violet) in
    // dark and 3.19:1 / 3.30:1 in light — all six pills below 4.5:1.
    for (const selector of [
      "\\.pipeline-stage-number",
      "\\.landing-step-number",
      "\\.pipeline-outcome-label",
    ]) {
      const rule = ruleBody(selector);
      expect(rule, `${selector} not found`).toMatch(/background:\s*var\(--card-accent-solid/);
      expect(rule, `${selector} still uses --card-accent as a fill`).not.toMatch(
        /var\(--card-accent[,)]/,
      );
    }
  });

  it("leaves the connector rail on the foreground step, and on one line only", () => {
    // .pipeline-rail-fill is a 3px line with no text on it. It is not a contrast
    // failure and does not need the solid step.
    // Matched against the stylesheet rather than one rule body: the fill's
    // geometry is shared with the track in one grouped selector and its colour
    // is in the block below, so no single `{}` holds both.
    expect(css).toMatch(/\.pipeline-rail-fill\s*\{[\s\S]*?var\(--blue\)[\s\S]*?var\(--green\)/);

    // #582 removed `.pipeline-stage::before`, the per-card accent bar that
    // predates it. Both were 3px at the same x, so each card painted its own
    // accent over the gradient while the 8px gap between cards showed the
    // gradient alone — measured, the line changed colour at all five
    // boundaries. This asserts the bar is still gone, because a rule that
    // "looks decorative" is exactly the kind that gets re-added by a later
    // change to make a card look accented.
    expect(css).not.toMatch(/\.pipeline-stage::before\s*\{/);
  });

  it("does not flip the numeral to dark ink in dark mode", () => {
    // The override this guards read as reasonable: dark accents are bright, so
    // a white numeral cannot survive them. It was true while the badge painted
    // --card-accent, and became exactly backwards once the fill was pinned dark
    // — dark ink on a dark fill, 2.51:1.
    expect(css).not.toMatch(/:root\[data-theme="dark"\]\s*\.landing-step-number\s*\{/);
  });
});

describe("coloured stat cards", () => {
  it("keeps the white 12px labels at AA on every accent fill", () => {
    // These are the only places left where a light label sits on a hard-coded
    // fill rather than a token, so they are asserted by value.
    for (const selector of [
      "\\.stat-processing",
      "\\.stat-ready",
      "\\.stat-pending",
      "\\.stat-users",
    ]) {
      const fill = token(ruleBody(selector), "background");
      const ratio = contrast(white, fill);
      expect(
        ratio,
        `${selector} fill ${fill} is ${ratio.toFixed(2)}:1 under white, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("tinted badges take the text step, not the fill step", () => {
  it("uses --green-text and --danger-text for the user-status pills", () => {
    // --success/--danger are 600-level fills. As 11px text on a 15% tint of
    // themselves they measured 2.67:1 light and 3.79:1 dark.
    const active = ruleBody("\\.user-status\\.is-active");
    expect(active).toMatch(/color:\s*var\(--green-text\)/);
    expect(active).not.toMatch(/color:\s*var\(--success/);
    const disabled = ruleBody("\\.user-status\\.is-disabled");
    expect(disabled).toMatch(/color:\s*var\(--danger-text\)/);
    expect(disabled).not.toMatch(/color:\s*var\(--danger\)/);
  });

  it("clears AA for the active pill on the tint in both themes", () => {
    // Composited over the theme's lightest panel, which is the worst case for
    // dark text on a green wash.
    for (const [theme, base] of [
      ["light", themed("light", "--paper")],
      ["dark", themed("dark", "--surface-2")],
    ] as const) {
      const tint = mix(themed(theme, "--success"), 15, base);
      const ratio = contrast(themed(theme, "--green-text"), tint);
      expect(
        ratio,
        `${theme} active pill is ${ratio.toFixed(2)}:1 on ${tint}, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the text steps for the success notices", () => {
    for (const selector of ["\\.success-message", "\\.webhook-notice-success"]) {
      const rule = ruleBody(selector);
      expect(rule, `${selector} not found`).toMatch(/color:\s*var\(--green-text\)/);
      expect(rule).not.toMatch(/color:\s*var\(--success/);
    }
  });

  it("clears AA for the Pro head on its own 12% wash in both themes", () => {
    // A --blue foreground step on a wash of itself is the same trap one tier up.
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const wash = mix(token(body, "--blue"), 12, token(body, "--surface-2"));
      const ratio = contrast(token(body, "--blue-text"), wash);
      expect(
        ratio,
        `${theme} Pro head is ${ratio.toFixed(2)}:1 on ${wash}, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("paints the Pro head with the text step", () => {
    const head = ruleBody("\\.landing-table th\\.pro-head");
    expect(head).toMatch(/color:\s*var\(--blue-text\)/);
    expect(head).not.toMatch(/color:\s*var\(--blue\)/);
  });
});

describe("small secondary text on raised panels", () => {
  it("takes --ink instead of --muted for the counts, labels and captions", () => {
    // --muted is body-secondary prose. As a 9.92-13.6px label or a count on a
    // panel it measured 3.45:1, 3.56:1, 4.16:1 and 4.21:1 — three of the four
    // under AA, and all four visually "obviously fine".
    for (const selector of [
      "\\.chip-count",
      "\\.code-block-label",
      "\\.webhook-tutorial-hint",
      "\\.webhook-snippet summary",
    ]) {
      const rule = ruleBody(selector);
      expect(rule, `${selector} not found`).toMatch(/color:\s*var\(--ink\)/);
      expect(rule, `${selector} still uses --muted`).not.toMatch(/color:\s*var\(--muted\)/);
    }
  });

  it("clears AA for --ink on the raised panels those rules sit on", () => {
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const surface of ["--line", "--surface-2"]) {
        const ratio = contrast(token(body, "--ink"), token(body, surface));
        expect(
          ratio,
          `${theme} --ink on ${surface} is ${ratio.toFixed(2)}:1, needs 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the code-string step at AA on the code surface", () => {
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ratio = contrast(token(body, "--code-string"), token(body, "--code-bg"));
      expect(
        ratio,
        `${theme} code string is ${ratio.toFixed(2)}:1, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("scrims that carry light text", () => {
  it("keeps the light-on-dark pills opaque enough to read", () => {
    // At 0.55 the carousel scrim let the page through and the slate-300 count
    // landed on a mid-grey field at 2.84:1. A scrim that satisfies every
    // structural check while being transparent is the same failure, so assert
    // the composited result rather than just the reference.
    for (const selector of ["\\.carousel-count", "\\.filter-chip\\.is-selected \\.chip-count"]) {
      const rule = ruleBody(selector);
      const scrim = token(rule, "background");
      const label = token(rule, "color");
      expect(
        alphaOf(scrim),
        `${selector} scrim alpha ${alphaOf(scrim)} is effectively transparent`,
      ).toBeGreaterThanOrEqual(0.8);
      // Over the lightest page, i.e. the weakest the field can get.
      const ratio = contrast(label, mix(scrim, alphaOf(scrim) * 100, white));
      expect(
        ratio,
        `${selector} label is ${ratio.toFixed(2)}:1 on its scrim, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not label a dark scrim with --paper", () => {
    // --paper inverts with the theme: white on a light page, near-black on a
    // dark one. A scrim that is dark in both themes has to be labelled with a
    // literal light tone, or dark mode puts #121927 on #1f3354 at 1.38:1.
    const selected = ruleBody("\\.filter-chip\\.is-selected \\.chip-count");
    expect(selected).not.toMatch(/color:\s*var\(--paper\)/);
    expect(selected).toMatch(/color:\s*#[0-9a-f]{6}/i);
  });
});

describe("form feedback text takes the text step, not the fill step (#471)", () => {
  // The third instance of the same mistake, found by the audit gate rather than
  // by eye. `--green`/`--danger` are 600-level *fill* tokens; these three rules
  // used them as the foreground of small body text:
  //
  //   .match-ok      green-600 on the auth card       3.30:1
  //   .match-bad     red-600 on the auth card         4.85:1 (passes, but a
  //                   sibling of a failing rule one line up)
  //   .error-message red-600 on --danger-soft         4.41:1 light, 3.35:1 dark
  //
  // The light `.error-message` case is the instructive one: 4.41 against a 4.5
  // bar reads as fine in review and fails every automated check. The dark case
  // is worse and points the other way — red-600 on a near-black surface needs a
  // *lighter* red, which is why this is the -text token and not a darker shade.

  it("uses the text steps for the password-match indicator", () => {
    const ok = ruleBody("\\.match-ok");
    expect(ok).toMatch(/color:\s*var\(--green-text\)/);
    expect(ok).not.toMatch(/color:\s*var\(--green\)/);
    const bad = ruleBody("\\.match-bad");
    expect(bad).toMatch(/color:\s*var\(--danger-text\)/);
    expect(bad).not.toMatch(/color:\s*var\(--danger\)/);
  });

  it("uses the text step for the error notice, keeping --danger for its fill", () => {
    const rule = ruleBody("\\.error-message");
    expect(rule).toMatch(/color:\s*var\(--danger-text\)/);
    expect(rule).not.toMatch(/color:\s*var\(--danger\)/);
    // The background and border stay on the fill steps: those *are* fills.
    expect(rule).toMatch(/background:\s*var\(--danger-soft\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--danger-line\)/);
  });

  it("clears AA for the password-match text in both themes", () => {
    // Worst case per theme: white in light, the lightest raised panel in dark
    // (the hardest field for light text), matching the rest of this file.
    for (const [theme, field] of [
      ["light", white],
      ["dark", themed("dark", "--surface-2")],
    ] as const) {
      for (const [selector, name] of [
        ["\\.match-ok", "--green-text"],
        ["\\.match-bad", "--danger-text"],
      ] as const) {
        const ratio = contrast(themed(theme, name), field);
        expect(
          ratio,
          `${theme} ${selector} is ${ratio.toFixed(2)}:1 on ${field}, needs 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("clears AA for the error notice on its own tint in both themes", () => {
    // Light --danger-soft is a literal; dark is a 14% wash of --danger, so it
    // has to be composited. The browser measured 5.82:1 on the real painted
    // field; compositing over the theme's lightest panel is the conservative
    // reading and still clears.
    for (const theme of ["light", "dark"] as const) {
      const soft = themed(theme, "--danger-soft");
      const field = soft.startsWith("rgb(")
        ? mix(themed(theme, "--danger"), 14, themed(theme, "--surface-2"))
        : soft;
      const ratio = contrast(themed(theme, "--danger-text"), field);
      expect(
        ratio,
        `${theme} .error-message is ${ratio.toFixed(2)}:1 on ${field}, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves the match chip's fill step alone, since every tone overrides it", () => {
    // `.result-match-chip`'s base rule paints 11px text green-600 on a 10% wash
    // — 2.93:1, a real failure — but MatchChip always emits a `tone-*` class and
    // each tone sets its own colour, background and border at higher
    // specificity. Unreachable today; pinned here so deleting the dead base
    // colour is a deliberate act rather than an accident.
    expect(ruleBody("\\.result-match-chip")).toMatch(/color:\s*var\(--green\)/);
    for (const tone of ["strong", "partial", "weak"]) {
      const rule = ruleBody(`\\.result-match-chip\\.tone-${tone}`);
      expect(rule, `tone-${tone} must set its own colour`).toMatch(/color:/);
      expect(rule, `tone-${tone} must set its own background`).toMatch(/background:/);
    }
  });
});
