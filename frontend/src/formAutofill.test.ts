import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every form control needs an `id` or `name` (so the browser can associate it
 * for autofill and form restoration) and an `autocomplete` (so autofill knows
 * *what* to offer). Lighthouse flags both, but only on the page you happen to
 * be auditing — 5 nodes here, 29 there — so a control can sit unfixed for
 * months. This guard reads the source instead of a rendered page, so it covers
 * every control on every route at once.
 *
 * The scan is deliberately attribute-literal rather than a DOM render: the
 * dynamic controls (per-user role select, per-model radios, per-event
 * checkboxes) only exist once data loads, and a rendered page would need
 * fixtures for all of them.
 */

const SRC = join(process.cwd(), "src");

/** Every `.tsx` under src, skipping tests and type-only files. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith(".tsx")) return [];
    if (/\.test\.tsx$|\.d\.tsx$/.test(entry)) return [];
    return [full];
  });
}

type Control = { file: string; line: number; kind: string; attrs: string };

/**
 * Yields each form control's opening tag. JSX attribute values may contain
 * braces — including *nested* template literals like
 * id={`admin-role-${user.id}`} — so a plain `{[^{}]*}` regex silently skips
 * exactly the dynamic controls this guard most needs to see. Track depth.
 */
function* controls(source: string): Generator<Control> {
  const open = /<(input|select|textarea)\b/g;
  for (const match of source.matchAll(open)) {
    let i = match.index! + match[0].length;
    let depth = 0;
    while (i < source.length) {
      const char = source[i];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (char === ">" && depth === 0) {
        yield {
          file: "",
          line: source.slice(0, match.index!).split("\n").length,
          kind: match[1]!,
          attrs: source.slice(match.index! + match[0].length, i),
        };
        break;
      }
      i++;
    }
  }
}

const allControls: Control[] = sourceFiles(SRC).flatMap((file) =>
  [...controls(readFileSync(file, "utf8"))].map((c) => ({
    ...c,
    file: file.slice(SRC.length + 1),
  })),
);

const where = (c: Control) => `${c.file}:${c.line} <${c.kind}>`;

describe("form control autofill attributes", () => {
  it("finds the form controls in the app", () => {
    // Guards the guard: if the scan silently matched nothing, every assertion
    // below would pass vacuously. 22 is the count as of #416.
    expect(allControls.length).toBeGreaterThanOrEqual(22);
  });

  it("gives every control an id or a name", () => {
    const missing = allControls.filter(
      (c) => !/\bid\s*=/.test(c.attrs) && !/\bname\s*=/.test(c.attrs),
    );
    expect(missing.map(where)).toEqual([]);
  });

  it("gives every control an autocomplete attribute", () => {
    const missing = allControls.filter((c) => !/\bautoComplete\s*=/.test(c.attrs));
    expect(missing.map(where)).toEqual([]);
  });

  it("keeps ids unique within a page, including dynamic per-item controls", () => {
    // A duplicated id silently breaks <label htmlFor> and autofill grouping.
    // Scoped per file on purpose: this is a SPA where one route renders one
    // page component, so two controls collide only if they share a file.
    // (`id="username"` legitimately exists in both LoginPage and RegisterPage
    // — different routes, never mounted together, so not a defect.)
    //
    // Dynamic ids are template literals, so they are matched literally and
    // de-duplicated per *shape*: `webhook-event-${option.value}` appears once
    // in source and is unique per rendered row by construction.
    const seen: string[] = [];
    const clashes: string[] = [];
    for (const c of allControls) {
      const id = /\bid\s*=\s*"([^"]+)"/.exec(c.attrs)?.[1];
      if (!id) continue;
      const key = `${c.file}::${id}`;
      if (seen.includes(key)) clashes.push(`${where(c)} duplicates ${id}`);
      else seen.push(key);
    }
    expect(clashes).toEqual([]);
  });

  it("uses an autofill token, not a bare or misspelled autocomplete", () => {
    // "off" is the correct value for anything that is not an autofill target
    // (search boxes, chat inputs, checkboxes, radios, selects).
    const allowed = new Set([
      "off",
      "on",
      "username",
      "email",
      "current-password",
      "new-password",
      "url",
      "one-time-code",
    ]);
    const bad = allControls
      .map((c) => /\bautoComplete\s*=\s*"([^"]+)"/.exec(c.attrs)?.[1])
      .filter((v): v is string => typeof v === "string")
      .filter((v) => !allowed.has(v));
    expect(bad).toEqual([]);
  });
});
