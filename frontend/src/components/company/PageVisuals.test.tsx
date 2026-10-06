/**
 * The five marketing-page figures must stay self-consistent.
 *
 * The same argument `ArchitectureDiagram.test.tsx` makes (#581), applied to the
 * drawings #585 added. These are drawn from coordinates in a `viewBox`, so the
 * failure mode is the same one: someone moves a box and the connector that used
 * to reach it now stops in open space, or runs across it, and no unit test fails
 * because every attribute is still a number and the JSX still compiles. A
 * screenshot diff cannot gate it either — five pages × two themes × three
 * widths is 30 captures to look at per change.
 *
 * So the rules the drawings depend on are asserted geometrically against the
 * *rendered* SVG, so renaming an attribute or moving a `<g>` changes what is
 * checked. Three rules, because connectors and marks are different things:
 *
 * 1. **A connector does not cross a box's interior.** #581: a line drawn over a
 *    box reads as a rendering bug rather than as routing.
 * 2. **A connector starts attached** — on a box edge, on a node, or on another
 *    connector. #581: a connector that begins in open space is a floating line.
 * 3. **A mark is contained by a box.** Marks stand for content *inside* a panel,
 *    so the opposite rule applies: they may never straddle an edge.
 *
 * Plus the containment and theming rules a reviewer would otherwise catch by
 * eye: nothing may escape the `viewBox`, and no text may be faded.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AboutVisual,
  BlogVisual,
  CareersVisual,
  CompanyVisual,
  ContactVisual,
} from "./PageVisuals";

type Rect = { x: number; y: number; w: number; h: number };
type Point = [number, number];
type Segment = { x1: number; y1: number; x2: number; y2: number };

const VISUALS = {
  CompanyVisual,
  AboutVisual,
  BlogVisual,
  CareersVisual,
  ContactVisual,
} as const;

const NAMES = Object.keys(VISUALS) as (keyof typeof VISUALS)[];

/** The highest opacity that is still a *panel wash* rather than content: the
 * 5% sheet fill and the 7% banner. Above this a `<rect>` is something the
 * drawing uses to mean something, so it is held to the non-text floor. */
const WASH = 0.08;

/** Tokenize a path `d` into `[command, ...numbers]` pairs, so a multi-line JSX
 * `d` and a single-line one tokenize identically. */
function tokens(d: string): [string, number[]][] {
  const out: [string, number[]][] = [];
  for (const match of d.matchAll(/([A-Za-z])|(-?\d*\.?\d+)/g)) {
    if (match[1]) out.push([match[1], []]);
    else {
      const last = out[out.length - 1];
      if (last) last[1].push(Number(match[2]));
    }
  }
  return out;
}

/** A command's first operand, or a hard failure. Indexing under
 * `noUncheckedIndexedAccess` yields `number | undefined`, and a geometry helper
 * that treated a missing operand as NaN would report a crossing that does not
 * exist — so a malformed path fails loudly instead. */
function operand(values: number[], d: string): number {
  const value = values[0];
  if (value === undefined) throw new Error(`Path command has no operand: "${d}"`);
  return value;
}

/**
 * Flatten a path into axis-aligned segments.
 *
 * Absolute (`H`/`V`) and relative (`h`/`v`) moves are both handled, because the
 * figures use each where it reads better. A curve (`C`) is deliberately
 * unsupported and throws: it would otherwise be silently dropped and pass as
 * "no segments", so the drawing would appear to satisfy rules 1 and 2 while
 * actually violating them. Better a loud failure than a silent pass.
 */
function segments(d: string): Segment[] {
  const out: Segment[] = [];
  let x = 0;
  let y = 0;
  let moved = false;

  const push = (nx: number, ny: number) => {
    if (nx === x && ny === y) return;
    if (Math.abs(nx - x) > 0.001 && Math.abs(ny - y) > 0.001) {
      throw new Error(`Diagonal move in "${d}" — the geometry checks only handle H/V`);
    }
    out.push({ x1: x, y1: y, x2: nx, y2: ny });
    x = nx;
    y = ny;
  };

  for (const [cmd, values] of tokens(d)) {
    switch (cmd) {
      case "M":
        x = operand(values, d);
        y = operand(values.slice(1), d);
        moved = true;
        break;
      case "m":
        x += operand(values, d);
        y += operand(values.slice(1), d);
        moved = true;
        break;
      case "H":
        push(operand(values, d), y);
        break;
      case "h":
        push(x + operand(values, d), y);
        break;
      case "V":
        push(x, operand(values, d));
        break;
      case "v":
        push(x, y + operand(values, d));
        break;
      default:
        throw new Error(`Unsupported path command "${cmd}" in "${d}"`);
    }
  }

  expect(moved, `path was never moved: "${d}"`).toBe(true);
  return out;
}

/** The point a connector attaches at: where its `d` begins. */
function startPoint(d: string): Point {
  const head = tokens(d)[0];
  if (!head) throw new Error(`Empty path: "${d}"`);
  return [operand(head[1], d), operand(head[1].slice(1), d)];
}

/** Every `<rect>`. Two per panel (wash + outline), which is harmless: the
 * assertions are containment/crossing tests, so duplicates repeat rather than
 * change the verdict. */
function rects(svg: SVGSVGElement): Rect[] {
  return [...svg.querySelectorAll("rect")].map((r) => ({
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    w: Number(r.getAttribute("width")),
    h: Number(r.getAttribute("height")),
  }));
}

/** Every `<circle>` as a box, so node dots are treated as attachment targets. */
function nodeBoxes(svg: SVGSVGElement): Rect[] {
  return [...svg.querySelectorAll("circle")].map((c) => {
    const r = Number(c.getAttribute("r"));
    return {
      x: Number(c.getAttribute("cx")) - r,
      y: Number(c.getAttribute("cy")) - r,
      w: r * 2,
      h: r * 2,
    };
  });
}

const EPS = 0.5;

function onBoxEdgeOf(point: Point, box: Rect): boolean {
  const [x, y] = point;
  const withinX = x >= box.x - EPS && x <= box.x + box.w + EPS;
  const withinY = y >= box.y - EPS && y <= box.y + box.h + EPS;
  const onVertical = Math.abs(x - box.x) < EPS || Math.abs(x - (box.x + box.w)) < EPS;
  const onHorizontal = Math.abs(y - box.y) < EPS || Math.abs(y - (box.y + box.h)) < EPS;
  return (onVertical && withinY) || (onHorizontal && withinX);
}

function onSegment(point: Point, seg: Segment): boolean {
  const [x, y] = point;
  if (seg.x1 === seg.x2) {
    return (
      Math.abs(seg.x1 - x) < EPS &&
      y >= Math.min(seg.y1, seg.y2) - EPS &&
      y <= Math.max(seg.y1, seg.y2) + EPS
    );
  }
  return (
    Math.abs(seg.y1 - y) < EPS &&
    x >= Math.min(seg.x1, seg.x2) - EPS &&
    x <= Math.max(seg.x1, seg.x2) + EPS
  );
}

function renderVisual(name: keyof typeof VISUALS) {
  const Visual = VISUALS[name];
  const { container } = render(<Visual />);
  const svg = container.querySelector("svg");
  expect(svg, `${name} rendered no svg`).not.toBeNull();
  return { container, svg: svg! };
}

/** The figure's own coordinate space, parsed from the attribute rather than
 * assumed — every containment bound below is checked against this, so a hardcoded
 * 360×240 would quietly stop meaning anything if the drawings were rescaled. */
function viewBoxOf(svg: SVGSVGElement, name: string): { w: number; h: number } {
  const parts = (svg.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  expect(parts.length, `${name} has no four-number viewBox`).toBe(4);
  const w = parts[2];
  const h = parts[3];
  expect(w, `${name} has no usable viewBox width`).toBeGreaterThan(0);
  expect(h, `${name} has no usable viewBox height`).toBeGreaterThan(0);
  return { w: w!, h: h! };
}

describe("page figure geometry", () => {
  it("draws no connector through a box", () => {
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      const boxes = rects(svg);
      const failures: string[] = [];

      for (const path of svg.querySelectorAll("path.fig-link")) {
        const d = path.getAttribute("d") ?? "";
        for (const seg of segments(d)) {
          for (const box of boxes) {
            // Interior only: a connector landing on an edge is how it attaches.
            const insideX = (v: number) => v > box.x + EPS && v < box.x + box.w - EPS;
            const insideY = (v: number) => v > box.y + EPS && v < box.y + box.h - EPS;
            const crosses =
              seg.x1 === seg.x2
                ? insideX(seg.x1) &&
                  Math.max(seg.y1, seg.y2) > box.y + EPS &&
                  Math.min(seg.y1, seg.y2) < box.y + box.h - EPS
                : insideY(seg.y1) &&
                  Math.max(seg.x1, seg.x2) > box.x + EPS &&
                  Math.min(seg.x1, seg.x2) < box.x + box.w - EPS;
            if (crosses) {
              failures.push(
                `${name}: (${seg.x1},${seg.y1})→(${seg.x2},${seg.y2}) crosses box at ` +
                  `(${box.x},${box.y}) ${box.w}×${box.h} — "${d}"`,
              );
            }
          }
        }
      }
      expect(failures).toEqual([]);
    }
  });

  it("attaches every connector to a box, a node, or another connector", () => {
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      const panels = rects(svg);
      const dots = nodeBoxes(svg);
      const paths = [...svg.querySelectorAll("path.fig-link")];
      const geometry = paths.map((p) => segments(p.getAttribute("d") ?? ""));

      paths.forEach((path, i) => {
        const d = path.getAttribute("d") ?? "";
        const point = startPoint(d);
        const stroke = Number(path.getAttribute("stroke-width") ?? 1.8);

        const onBoxEdge = [...panels, ...dots].some((b) => onBoxEdgeOf(point, b));
        // A connector may also start at a node's *centre*, which is how a spine
        // taps the dot it is anchored to. Accepting the centre rather than only
        // the circumference is what lets the spine's ends coincide with the
        // first and last node instead of floating a unit past them.
        const onNode = dots.some((dot) => {
          const cx = dot.x + dot.w / 2;
          const cy = dot.y + dot.h / 2;
          return Math.hypot(point[0] - cx, point[1] - cy) <= stroke / 2 + 2;
        });
        const onOther = geometry.some(
          (segs, j) => j !== i && segs.some((s) => onSegment(point, s)),
        );

        expect(
          onBoxEdge || onNode || onOther,
          `${name}: connector starts unattached at (${point[0]},${point[1]}): "${d}"`,
        ).toBe(true);
      });
    }
  });

  it("keeps every in-panel mark inside one box", () => {
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      const boxes = rects(svg);
      const failures: string[] = [];

      for (const path of svg.querySelectorAll("path.fig-mark")) {
        const d = path.getAttribute("d") ?? "";
        const points: Point[] = [startPoint(d)];
        for (const seg of segments(d)) points.push([seg.x2, seg.y2]);
        const stroke = Number(path.getAttribute("stroke-width") ?? 1.8);
        const pad = stroke / 2 + EPS;
        const contained = boxes.some((b) =>
          points.every(
            ([px, py]) =>
              px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad,
          ),
        );
        if (!contained) {
          failures.push(`${name}: mark is not inside any box — "${d}"`);
        }
      }
      expect(failures).toEqual([]);
    }
  });

  it("draws nothing outside the viewBox", () => {
    // A coordinate past the edge of the `viewBox` is silently clipped, so the
    // drawing loses a piece with no error anywhere. This is the cheapest
    // possible check on every coordinate in all five figures.
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      const { w: vw, h: vh } = viewBoxOf(svg, name);

      const failures: string[] = [];
      for (const b of [...rects(svg), ...nodeBoxes(svg)]) {
        const pad = b.w === b.h ? 0 : 1; // circles already carry their radius
        if (b.x - pad < 0 || b.y - pad < 0 || b.x + b.w + pad > vw || b.y + b.h + pad > vh) {
          failures.push(`${name}: box (${b.x},${b.y}) ${b.w}×${b.h} escapes ${vw}×${vh}`);
        }
      }
      for (const path of svg.querySelectorAll("path")) {
        const d = path.getAttribute("d") ?? "";
        const points: Point[] = [startPoint(d)];
        for (const seg of segments(d)) points.push([seg.x2, seg.y2]);
        const stroke = Number(path.getAttribute("stroke-width") ?? 1.8);
        // Round caps overhang the endpoint by half the stroke.
        const pad = stroke / 2;
        for (const [x, y] of points) {
          if (x - pad < 0 || y - pad < 0 || x + pad > vw || y + pad > vh) {
            failures.push(`${name}: point (${x},${y}) escapes ${vw}×${vh} — "${d}"`);
          }
        }
      }
      for (const t of svg.querySelectorAll("text")) {
        const x = Number(t.getAttribute("x"));
        const y = Number(t.getAttribute("y"));
        if (x < 0 || x > vw || y < 0 || y > vh) {
          failures.push(`${name}: text at (${x},${y}) escapes ${vw}×${vh}`);
        }
      }
      expect(failures).toEqual([]);
    }
  });

  it("draws the four quadrants identically, up to position", () => {
    /* A first version shortened the lower rule of the bottom-right panel, and a
       review caught it: with nothing in the drawing marking the difference, it
       read as a typo rather than a choice. A pattern with an unmarked exception
       is a mistake waiting to be read as one.

       So the rule is identity under translation — compare each quadrant's
       geometry with its own origin removed, rather than asserting four literal
       numbers that a legitimate repositioning would then "break". */
    const { svg } = renderVisual("AboutVisual");
    const groups = [...svg.querySelectorAll("g")];
    expect(groups.length, "AboutVisual is not four quadrants").toBe(4);

    const signature = (group: Element): string => {
      const boxes = [...group.querySelectorAll("rect")].map((r) => ({
        x: Number(r.getAttribute("x")),
        y: Number(r.getAttribute("y")),
        w: Number(r.getAttribute("width")),
        h: Number(r.getAttribute("height")),
      }));
      const ox = Math.min(...boxes.map((b) => b.x));
      const oy = Math.min(...boxes.map((b) => b.y));
      // Deltas, not absolute coordinates: a move must not read as a difference.
      const strokes = [...group.querySelectorAll("path")].map((p) =>
        segments(p.getAttribute("d") ?? "").map((s) => [s.x2 - s.x1, s.y2 - s.y1]),
      );
      return JSON.stringify({
        boxes: boxes.map((b) => [b.x - ox, b.y - oy, b.w, b.h]),
        strokes,
      });
    };

    const distinct = new Set(groups.map(signature));
    expect(
      distinct.size,
      `the four quadrants differ; signatures: ${[...distinct].join(" | ")}`,
    ).toBe(1);
  });

  it("fills every dot, so nothing in a drawing reads as an unselected control", () => {
    /* `/careers`' row markers were hollow circles, and a review read them as
       unselected radio buttons — the one affordance a role row must not imply,
       since nothing on these pages is selectable. `/blog`'s drawing drops its ring
       for the same reason. A filled dot cannot be read as a control.

       Asserted as a blanket rule over every circle in all five figures, so a new
       ring cannot be added later without tripping it. */
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      for (const c of svg.querySelectorAll("circle")) {
        expect(
          c.getAttribute("fill"),
          `${name}: a hollow circle reads as an unselected control`,
        ).not.toBe("none");
      }
    }
  });

  it("uses only axis-aligned moves, so the checks above cannot be bypassed", () => {
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      for (const path of svg.querySelectorAll("path")) {
        const d = path.getAttribute("d") ?? "";
        expect(d, "a curve or diagonal would escape the segment checks").toMatch(
          /^M -?[\d.]+ -?[\d.]+( [HhVv] -?[\d.]+)+$/,
        );
      }
    }
  });
});

describe("page figure accessibility and theming", () => {
  it("renders five distinct figures, each hidden from assistive tech", () => {
    // Each restates something the prose beside it already says, so the prose is
    // the text equivalent. The blog figure is the one that is not a restatement —
    // it is the empty state's subject — and it is still hidden because its
    // heading and the two sentences below it carry the message.
    const labels = new Set<string>();
    for (const name of NAMES) {
      const { container, svg } = renderVisual(name);
      expect(svg, `${name} is not aria-hidden`).toHaveAttribute("aria-hidden", "true");
      expect(svg, `${name} may still be tabbed to in some AT`).toHaveAttribute(
        "focusable",
        "false",
      );
      const wrapper = container.querySelector(".page-figure");
      expect(wrapper).not.toBeNull();
      const label = wrapper!.getAttribute("data-figure");
      expect(label, `${name} has no data-figure`).toBeTruthy();
      labels.add(label!);
    }
    expect(labels.size, "the five figures need five names").toBe(NAMES.length);
  });

  it("fades no text", () => {
    // #581 measured subtitles at 2.84–4.23:1 against their own fills purely
    // because of `opacity` on the text. These carry a 0.85 `path` rule and an
    // 8% wash panel, so a future "let's soften the labels" is the exact trap.
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      for (const t of svg.querySelectorAll("text")) {
        expect(t.getAttribute("opacity"), `${name}: <text> carries opacity`).toBeNull();
        expect(t.getAttribute("fill-opacity"), `${name}: <text> carries fill-opacity`).toBeNull();
      }
    }
  });

  it("puts no words in the empty-state figure", () => {
    // The blog shows no posts, so a drawing that names one would be fabricating
    // it with fewer pixels — the rule the empty state already follows in text.
    const { svg } = renderVisual("BlogVisual");
    expect(svg.querySelectorAll("text").length).toBe(0);
  });

  it("holds every faded fill to the same floor as the strokes", () => {
    /* The 3:1 rule in `.page-figure path` only ever covered `<path>`. The blog
       sheet's ruled lines are `<rect>`s faded with an inline `opacity`, so they
       sat outside it — and measured 1.38:1 light / 1.55:1 dark against their own
       sheet while the same audit reported "10.5:1 strokes" and passed. A rule
       that only covers the elements someone remembered is not a rule.

       This asserts on the opacity rather than on a measured ratio, because the
       ratio depends on the composited wash and the theme: solving for 3:1 gives
       0.50 in light and 0.40 in dark, and one value has to serve both. 0.5 clears
       both (3.26:1 light, 3.91:1 dark as measured).

       Panel washes are excluded — a 5% background is a background, not something
       the drawing uses to mean anything — so the floor is 0.08, not 0.5. */
    for (const name of NAMES) {
      const { svg } = renderVisual(name);
      for (const r of svg.querySelectorAll("rect[opacity]")) {
        const a = Number(r.getAttribute("opacity"));
        if (a <= WASH) continue;
        expect(a, `${name}: a faded fill at ${a} is below the 3:1 floor`).toBeGreaterThanOrEqual(
          0.5,
        );
      }
    }
  });

  it("keeps the sheet's ruled lines distinguishable from one another", () => {
    // Hierarchy without opacity: a heavier title rule over lighter body rules.
    // Two equal values would leave the title looking like the first line of text.
    const { svg } = renderVisual("BlogVisual");
    const rules = [...svg.querySelectorAll("rect[opacity]")]
      .map((r) => Number(r.getAttribute("opacity")))
      .filter((a) => a > WASH);
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(new Set(rules).size).toBe(2);
  });
});

describe("page figure stylesheet rules", () => {
  const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");

  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open, close);
  };

  /** The body of the `@media` block that contains `selector`.
   *
   * Searching for the *query* is not enough: `@media (max-width: 900px)` opens
   * the landing navbar's block hundreds of lines above `.page-split`'s, and
   * `indexOf` returns the first one — so the test would assert against unrelated
   * declarations and pass for the wrong reason. Finding the query and then
   * matching the whole balanced block, and requiring the selector to be in it,
   * is what makes the assertion mean what it says. */
  const mediaBlock = (query: string, selector?: string): string => {
    let from = 0;
    while (from < css.length) {
      const at = css.indexOf(query, from);
      if (at === -1) break;
      const open = css.indexOf("{", at);
      let depth = 0;
      let end = -1;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === "{") depth += 1;
        if (css[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) throw new Error(`unterminated ${query}`);
      const body = css.slice(open, end);
      if (!selector || body.includes(selector)) return body;
      from = end;
    }
    throw new Error(`no ${query} block containing ${selector ?? "(any selector)"}`);
  };

  it("gives figure text `--ink` at no opacity, in both roles", () => {
    // `--muted` measures 5.12:1 on `--paper` but 4.41:1 on the 8% accent wash
    // this panel paints (12px, so AA wants 4.5:1). Hierarchy is size and weight.
    for (const selector of [".fig-label", ".fig-sub"]) {
      expect(rule(selector)).toMatch(/fill:\s*var\(--ink\)/);
      expect(rule(selector), `${selector} fades its text`).not.toMatch(/opacity/);
    }
    // The two roles must differ in something other than opacity, or they are
    // the same rule twice.
    expect(rule(".fig-label")).not.toBe(rule(".fig-sub"));
  });

  it("states the figure's colour instead of inheriting whatever the page set", () => {
    // `currentColor` is what every stroke resolves to, so a contrast
    // measurement is only repeatable against a stated colour.
    expect(rule(".page-figure")).toMatch(/color:\s*var\(--ink\)/);
  });

  it("holds strokes at a measured non-text contrast", () => {
    // 10.5:1 light, 9.3:1 dark against the washed panel. Asserted as a floor
    // because the number is the point: a softer line chosen by eye is the
    // regression, and it is invisible in both themes at once.
    const strokes = rule(".page-figure path");
    const opacity = Number(strokes.match(/opacity:\s*([\d.]+)/)?.[1]);
    expect(opacity).toBeGreaterThanOrEqual(0.85);
  });

  it("collapses the split at 900px, where the measure is still 62 characters", () => {
    // The measured reason: at 768px a two-column split gives 318px of prose —
    // ~39 characters, below the 45-character floor `pageMeasure.test.ts` holds.
    // `.page-grid--n*` collapses at 720px because its cards are equal length;
    // copying that point here is what put 39 characters on the page.
    const narrow = mediaBlock("@media (max-width: 900px)", ".page-split {");
    expect(narrow).toMatch(/\.page-split \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule(".page-split")).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    );
  });

  it("centres the figure rather than stretching it against taller prose", () => {
    // A stretched panel is a 600px box with a 240px drawing marooned in it.
    expect(rule(".page-figure")).toMatch(/align-self:\s*center/);
    expect(rule(".page-figure")).toMatch(/min-height:\s*240px/);
  });

  it("drops the wash and shadow for readers who asked for less data", () => {
    const reduced = mediaBlock("@media (prefers-reduced-data: reduce)", ".page-figure");
    expect(reduced).toMatch(/\.page-figure::before \{[^}]*display:\s*none/);
    expect(reduced).toMatch(/\.page-figure \{[^}]*box-shadow:\s*none/);
  });
});
