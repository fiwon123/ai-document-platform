import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Workspace app-bar contrast guard.
 *
 * The navbar used to paint `var(--ink)`/`var(--paper)`, a pair that inverts
 * with the theme. That produced two defects nobody could see in review:
 *
 *   - the active tab was `background: var(--blue); color: #fff`, and `--blue`
 *     is `#60a5fa` in dark mode — white on it is **2.54:1**, the one AA failure
 *     on the bar, on the one control you look at to know where you are;
 *   - hovers were `color-mix(... var(--paper) 8%)`, i.e. 8% of a near-black on
 *     a light bar in dark mode. Measured on rendered pixels the logout button's
 *     hover moved the background by **2 of 255** — no change at all.
 *
 * jsdom does not resolve custom properties from the real stylesheet, so this
 * reads the source and does the WCAG arithmetic itself. That is the right level
 * here: the failure mode is a bad pair of values in the token table, and
 * asserting the number is what stops a well-meaning `--blue` swap from
 * reintroducing a 2.5:1 tab.
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
  // tsconfig has noUncheckedIndexedAccess, so the destructured pair is
  // `number | undefined` even though the sort always yields two entries.
  const hi = sorted[0];
  const lo = sorted[1];
  if (hi === undefined || lo === undefined) {
    throw new Error(`cannot order luminances for ${a} / ${b}`);
  }
  return (hi + 0.05) / (lo + 0.05);
};

const light = ruleBody(":root");
const dark = ruleBody(':root\\[data-theme\\="dark"\\]');

describe("workspace app bar", () => {
  it("declares every app-bar token in both themes", () => {
    // A token declared in only one theme falls back to the other theme's value,
    // which is how the bar ended up light-on-light in the first place.
    for (const name of [
      "--appbar-bg",
      "--appbar-fg",
      "--appbar-muted",
      "--appbar-line",
      "--appbar-active-bg",
      "--appbar-active-fg",
      "--appbar-wash",
    ]) {
      expect(token(light, name), `${name} missing from :root`).toBeTruthy();
      expect(token(dark, name), `${name} missing from the dark block`).toBeTruthy();
    }
  });

  it("keeps the active tab at or above AA in both themes", () => {
    // This is the assertion that would have caught the original defect: the
    // dark pair measured 2.54:1 while reading perfectly reasonably in review.
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const ratio = contrast(token(body, "--appbar-active-fg"), token(body, "--appbar-active-bg"));
      expect(
        ratio,
        `${theme} active tab is ${ratio.toFixed(2)}:1, needs 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("does not take the active fill from --blue", () => {
    // --blue is theme-dependent (#2563eb light, #60a5fa dark). The active tab
    // must not follow it, or the tab goes to 2.54:1 the moment the theme flips.
    const active = css.match(
      /\.navbar-links a\.active,\s*\n?\.navbar-links a\[aria-current="page"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(active, "active nav rule not found").toBeTruthy();
    expect(active).toMatch(/background:\s*var\(--appbar-active-bg\)/);
    expect(active).toMatch(/color:\s*var\(--appbar-active-fg\)/);
    expect(active).not.toMatch(/var\(--blue\)/);
  });

  it("stays a dark bar in both themes rather than inverting", () => {
    // The design decision behind the tokens: the bar used to invert, which put
    // a glaring near-white slab across the top of every dark page. Pin both
    // ends dark so the inversion cannot come back.
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const bg = luminance(parseColor(token(body, "--appbar-bg")));
      expect(bg, `${theme} app bar is not dark (luminance ${bg.toFixed(3)})`).toBeLessThan(0.05);
    }
  });

  it("paints the bar with the app-bar tokens, not the inverting pair", () => {
    const bar = css.match(/\.navbar\s*\{([^}]*)\}/)?.[1];
    expect(bar, ".navbar rule not found").toBeTruthy();
    expect(bar).toMatch(/background:\s*var\(--appbar-bg\)/);
    expect(bar).toMatch(/color:\s*var\(--appbar-fg\)/);
    // The solid fallback declaration immediately above the color-mix one.
    expect(bar).not.toMatch(/var\(--ink\)/);
    expect(bar).not.toMatch(/var\(--paper\)/);
  });

  it("keeps the hover wash visible in both themes", () => {
    // The tests above only prove the rules *reference* the wash. That is not
    // enough: a wash left at zero alpha satisfies every one of them while
    // hover is invisible again — the exact defect being fixed. So assert the
    // wash is actually opaque enough, and that it lightens a dark bar rather
    // than tinting toward the bar's own colour.
    for (const [theme, body] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const wash = token(body, "--appbar-wash");
      const alpha = Number(wash.match(/\/\s*([\d.]+)\s*\)/)?.[1] ?? "1");
      expect(
        alpha,
        `${theme} wash alpha ${alpha} is effectively transparent`,
      ).toBeGreaterThanOrEqual(0.08);
      expect(
        luminance(parseColor(wash)),
        `${theme} wash is not lighter than the bar it sits on`,
      ).toBeGreaterThan(luminance(parseColor(token(body, "--appbar-bg"))));
    }
  });

  it("gives hovers and the secondary button a visible wash", () => {
    // Each of these was a no-op or near-no-op: a hover that moved the
    // background by 2/255, and a logout hover that moved it by nothing.
    for (const selector of [
      "\\.navbar-links a:hover",
      "\\.navbar-back-link:hover",
      "\\.navbar \\.btn-secondary:hover:not\\(:disabled\\)",
    ]) {
      const rule = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];
      expect(rule, `${selector} not found`).toBeTruthy();
      expect(rule).toMatch(/background:\s*var\(--appbar-wash\)/);
      expect(rule).not.toMatch(/var\(--paper\)/);
      expect(rule).not.toMatch(/var\(--ink\)/);
    }
  });
});
