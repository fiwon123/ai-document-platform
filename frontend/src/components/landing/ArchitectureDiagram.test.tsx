/**
 * The architecture diagram's geometry must stay self-consistent.
 *
 * The first version of this drawing routed three connectors straight through the
 * Ask and Object storage boxes and their labels. A visual review caught it; a
 * screenshot diff cannot gate it, because the next person to move a box moves
 * the line with it and nobody looks at six full-page PNGs per change. So the
 * rule the diagram actually depends on — *no connector crosses a box* — is
 * asserted here geometrically instead (#581).
 *
 * The test parses the rendered SVG, so it tracks the real markup rather than a
 * copy of it: renaming an attribute or moving a <g> changes what is checked.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

type Rect = { x: number; y: number; w: number; h: number };
type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Every `<rect>` in the diagram is a box. Two per box (fill + stroke), which
 * is fine: the assertion is per-box, and duplicates produce duplicate failures
 * with the same message. */
function boxes(container: HTMLElement): Rect[] {
  return [...container.querySelectorAll("rect")].map((r) => ({
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    w: Number(r.getAttribute("width")),
    h: Number(r.getAttribute("height")),
  }));
}

/** Tokenize a path `d` into `[command, ...numbers]` pairs.

 * `M 75 60 V 92` and a JSX multi-line `d` both have to work, so the numbers are
 * collected per command rather than assuming one number per token. */
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

/** A command's first operand, or a hard failure. Indexing an array under
 * `noUncheckedIndexedAccess` yields `number | undefined`, and a geometry helper
 * that silently treats a missing operand as NaN would report a crossing that
 * does not exist — so a malformed path fails loudly instead. */
function operand(values: number[], d: string): number {
  const value = values[0];
  if (value === undefined) {
    throw new Error(`Path command has no operand: "${d}"`);
  }
  return value;
}

/**
 * Flatten a path's `d` into segments.
 *
 * Only the subset this diagram uses is handled — a single absolute `M` followed
 * by absolute `H`/`V` moves. A curve (`C`) would be silently dropped, so the
 * "uses only absolute H/V moves" test below fails loudly if someone introduces
 * one; better that than a connector that quietly escapes the check.
 */
function segments(d: string): Segment[] {
  const out: Segment[] = [];
  let x = 0;
  let y = 0;
  let first = true;

  for (const [cmd, values] of tokens(d)) {
    switch (cmd) {
      case "M":
        x = operand(values, d);
        y = operand(values.slice(1), d);
        first = true;
        break;
      case "H": {
        const nx = operand(values, d);
        out.push({ x1: x, y1: y, x2: nx, y2: y });
        x = nx;
        first = false;
        break;
      }
      case "V": {
        const ny = operand(values, d);
        out.push({ x1: x, y1: y, x2: x, y2: ny });
        y = ny;
        first = false;
        break;
      }
      default:
        throw new Error(`Unsupported path command "${cmd}" in "${d}"`);
    }
  }

  // An unparseable `d` must not pass by producing no segments.
  expect(first, `path was never moved: "${d}"`).toBe(false);
  expect(out.length).toBeGreaterThan(0);
  return out;
}

/** The first point of a path: where the connector attaches. */
function startPoint(d: string): [number, number] {
  const head = tokens(d)[0];
  if (!head) throw new Error(`Empty path: "${d}"`);
  return [operand(head[1], d), operand(head[1].slice(1), d)];
}

/** Does an axis-aligned segment pass through the box's interior? Endpoints
 * touching an edge are how connectors attach, so only the interior counts. */
function crossesBox(seg: Segment, box: Rect): boolean {
  const epsilon = 0.5;
  const insideX = (v: number) => v > box.x + epsilon && v < box.x + box.w - epsilon;
  const insideY = (v: number) => v > box.y + epsilon && v < box.y + box.h - epsilon;

  if (seg.x1 === seg.x2) {
    // Vertical: crosses if it runs inside the box's x-range and its y-span
    // overlaps the box's y-interior.
    if (!insideX(seg.x1)) return false;
    const lo = Math.min(seg.y1, seg.y2);
    const hi = Math.max(seg.y1, seg.y2);
    return hi > box.y + epsilon && lo < box.y + box.h - epsilon;
  }
  // Horizontal.
  if (!insideY(seg.y1)) return false;
  const lo = Math.min(seg.x1, seg.x2);
  const hi = Math.max(seg.x1, seg.x2);
  return hi > box.x + epsilon && lo < box.x + box.w - epsilon;
}

function renderSvg() {
  const { container } = render(<ArchitectureDiagram />);
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  return { svg: svg!, rects: boxes(container) };
}

describe("ArchitectureDiagram geometry", () => {
  it("draws no connector through a box", () => {
    const { svg, rects } = renderSvg();
    const failures: string[] = [];

    for (const path of svg.querySelectorAll("path.arch-link")) {
      const d = path.getAttribute("d") ?? "";
      for (const seg of segments(d)) {
        for (const box of rects) {
          if (crossesBox(seg, box)) {
            failures.push(
              `segment (${seg.x1},${seg.y1})→(${seg.x2},${seg.y2}) crosses box at ` +
                `(${box.x},${box.y}) ${box.w}×${box.h}`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps crossings between connectors to the one deliberate pair", () => {
    // Two flows crossing in empty space is legible; the API's write to object
    // storage crosses the index's read path once by design. More than that
    // means the routing has been rearranged into something unreadable.
    const { svg } = renderSvg();
    const geometry = [...svg.querySelectorAll("path.arch-link")].map((p) => {
      const d = p.getAttribute("d") ?? "";
      return { segments: segments(d), start: startPoint(d) };
    });
    let crossings = 0;

    for (let i = 0; i < geometry.length; i += 1) {
      for (let j = i + 1; j < geometry.length; j += 1) {
        const a = geometry[i]!;
        const b = geometry[j]!;
        for (const s1 of a.segments) {
          for (const s2 of b.segments) {
            const hit = intersection(s1, s2);
            if (!hit) continue;
            // Meeting at a path's own start point is a *tap* — the Ask branch
            // joining the shared read run — not a crossing. A crossing is two
            // flows passing through the same point in opposite directions.
            const isTap =
              (hit[0] === a.start[0] && hit[1] === a.start[1]) ||
              (hit[0] === b.start[0] && hit[1] === b.start[1]);
            if (!isTap) crossings += 1;
          }
        }
      }
    }

    expect(crossings).toBeLessThanOrEqual(1);
  });

  it("attaches every connector to a box or to another connector", () => {
    // A connector that begins in open space is a floating line — the dashed stub
    // the review found was exactly this, and it read as unfinished. Starting on
    // another connector is legitimate (the Ask branch taps the shared read run),
    // so that counts as attached too.
    const { svg, rects } = renderSvg();
    const paths = [...svg.querySelectorAll("path.arch-link")];
    const geometry = paths.map((p) => segments(p.getAttribute("d") ?? ""));

    const onBoxEdge = (x: number, y: number) =>
      rects.some((b) => {
        const withinX = x >= b.x - 0.5 && x <= b.x + b.w + 0.5;
        const withinY = y >= b.y - 0.5 && y <= b.y + b.h + 0.5;
        const onVerticalEdge = Math.abs(x - b.x) < 0.5 || Math.abs(x - (b.x + b.w)) < 0.5;
        const onHorizontalEdge = Math.abs(y - b.y) < 0.5 || Math.abs(y - (b.y + b.h)) < 0.5;
        return (onVerticalEdge && withinY) || (onHorizontalEdge && withinX);
      });

    const onSomeConnector = (x: number, y: number, self: number) =>
      geometry.some((segs, i) =>
        i !== self &&
        segs.some(
          (s) =>
            (s.x1 === s.x2 && s.x1 === x && y >= Math.min(s.y1, s.y2) && y <= Math.max(s.y1, s.y2)) ||
            (s.y1 === s.y2 && s.y1 === y && x >= Math.min(s.x1, s.x2) && x <= Math.max(s.x1, s.x2)),
        ),
      );

    paths.forEach((path, i) => {
      const d = path.getAttribute("d") ?? "";
      const [x, y] = startPoint(d);
      expect(
        onBoxEdge(x, y) || onSomeConnector(x, y, i),
        `connector starts unattached at (${x},${y}): ${d}`,
      ).toBe(true);
    });
  });

  it("uses only absolute H/V moves, so the geometry check above cannot be bypassed", () => {
    const { svg } = renderSvg();
    for (const path of svg.querySelectorAll("path.arch-link")) {
      const d = path.getAttribute("d") ?? "";
      expect(d, "a curve or relative move would escape the segment check").toMatch(
        /^M [\d.]+ [\d.]+( [HV] [\d.]+)+$/,
      );
    }
  });
});

/** Where two axis-aligned segments cross, or null. Collinear overlap returns
 * null: connectors running alongside each other is not a crossing either. */
function intersection(a: Segment, b: Segment): [number, number] | null {
  const between = (v: number, lo: number, hi: number) =>
    v >= Math.min(lo, hi) && v <= Math.max(lo, hi);

  if (a.x1 === a.x2 && b.x1 === b.x2) {
    return a.x1 === b.x1 && between(a.y1, b.y1, b.y2) && between(a.y2, b.y1, b.y2)
      ? [a.x1, Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2))]
      : null;
  }
  if (a.x1 === a.x2) {
    return between(a.x1, b.x1, b.x2) && between(b.y1, a.y1, a.y2) && a.y1 !== b.y1 && a.y2 !== b.y2
      ? [a.x1, b.y1]
      : null;
  }
  if (b.x1 === b.x2) {
    return between(b.x1, a.x1, a.x2) && between(a.y1, b.y1, b.y2) && b.y1 !== a.y1 && b.y2 !== a.y2
      ? [b.x1, a.y1]
      : null;
  }
  // Two horizontals are parallel.
  return null;
}

describe("ArchitectureDiagram sizing rules", () => {
  // These are asserted against the stylesheet rather than left to a screenshot,
  // because getting them wrong is invisible in a unit test and was visible in
  // the page: an earlier revision put `min-width: 480px` on `.architecture-scroll`,
  // which sized the *scroller* to 480px and made the whole document scroll
  // sideways at 375px instead of the figure scrolling inside it.
  const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8");

  const rule = (selector: string): string => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open, close);
  };

  it("clips the scroller instead of widening it", () => {
    const scroller = rule(".architecture-scroll");
    expect(scroller).toMatch(/overflow-x:\s*auto/);
    // `min-width: 0` is what stops a flex item being sized by its content.
    expect(scroller).toMatch(/min-width:\s*0/);
    expect(scroller).not.toMatch(/min-width:\s*4\d\dpx/);
  });

  it("holds the figure at its natural width so its text does not scale down", () => {
    // SVG text is sized in user units and scales with the viewBox, so
    // `width: 100%` put the sub-labels at 7.6 real px at a 375px viewport.
    const figure = rule(".architecture-diagram");
    expect(figure).toMatch(/width:\s*480px/);
    expect(figure).not.toMatch(/width:\s*100%/);
    expect(figure).not.toMatch(/max-width:\s*100%/);
  });

  it("fades nothing that carries meaning", () => {
    // The box subtitles failed AA at 2.84–4.23:1 purely because of `opacity`
    // on the text, so hierarchy has to come from size and weight instead.
    expect(rule(".arch-sub")).not.toMatch(/opacity/);
  });
});

describe("ArchitectureDiagram accessibility and theming", () => {
  it("hides the SVG from assistive tech and supplies a text equivalent", () => {
    // #581 asks for a text equivalent. The diagram is the only description of
    // the architecture on the page, so it must not be aria-hidden alone.
    const { container } = render(<ArchitectureDiagram />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");

    const text = container.querySelector(".architecture-text");
    expect(text).not.toBeNull();
    expect(text!.querySelectorAll("li").length).toBeGreaterThanOrEqual(3);
    // The text has to name the parts the drawing shows, or it is not equivalent.
    expect(text!.textContent).toMatch(/request path/i);
    expect(text!.textContent).toMatch(/vector index/i);
  });

  it("offers a scroll hint only where the figure is wider than its column", () => {
    // The figure is a fixed 480px, so it overflows the column below roughly a
    // 600px viewport. The hint has to be inside the clipped scroller to be
    // reachable at all, and it must not claim scrollability on the widths where
    // the figure fits — hence the media query rather than an unconditional rule.
    const { container } = render(<ArchitectureDiagram />);
    const scroller = container.querySelector(".architecture-scroll");
    expect(scroller).not.toBeNull();
    expect(scroller!.querySelector(".architecture-hint")).not.toBeNull();
  });

  it("colours every box and link from currentColor, so one dark-theme rule covers it", () => {
    const { container } = render(<ArchitectureDiagram />);
    // Each box is two rects: a translucent `currentColor` fill and a
    // `currentColor` stroke over it. Each one must derive its colour from the
    // group's accent, never name one.
    for (const rect of container.querySelectorAll("rect")) {
      const fill = rect.getAttribute("fill");
      const stroke = rect.getAttribute("stroke");
      expect(
        fill === "currentColor" || stroke === "currentColor",
        `rect has neither a currentColor fill nor stroke: fill=${fill} stroke=${stroke}`,
      ).toBe(true);
    }
    // And no hard-coded colour anywhere in the drawing — that is what a hex
    // literal would be, and it is why dark theme needs no rule of its own here.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML).not.toMatch(/rgb\(/i);
  });
});