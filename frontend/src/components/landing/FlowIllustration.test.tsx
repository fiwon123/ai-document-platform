/**
 * The landing page's illustration must stay a decorative inline SVG.
 *
 * #580 requires SVG, colocated, no bitmap assets and no external image hosts.
 * A regression here would be a `<img src="/hero.png">` — nothing in the build
 * fails, the page just quietly stops meeting the requirement and ships a 200KB
 * asset that the theme cannot recolour.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FlowIllustration } from "./FlowIllustration";

const raw = readFileSync(
  resolve(process.cwd(), "src", "components", "landing", "FlowIllustration.tsx"),
  "utf8",
);

/** The source with comments stripped: the prose above explains these very
 * rules and names `#580`, so matching on the raw file would trip over its own
 * documentation. */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("FlowIllustration", () => {
  it("renders an inline svg, not an image element", () => {
    const { container } = render(<FlowIllustration />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // Every `url(` in the file must be a local fragment reference — the marker
    // defined in this same figure — not a fetch of an external asset.
    expect(src).not.toMatch(/<img\b/i);
    for (const m of src.matchAll(/url\(\s*([^)]*)\)/g)) {
      const ref = m[1] ?? "";
      expect(ref.trim(), `url(${ref}) is not a local fragment reference`).toMatch(/^#[\w-]+$/);
    }
  });

  it("is hidden from assistive tech, since the step cards state it in words", () => {
    const { container } = render(<FlowIllustration />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBe("presentation");
    expect(svg.getAttribute("focusable")).toBe("false");
    // No accessible name: an illustration duplicating its caption is noise.
    expect(svg.getAttribute("aria-label")).toBeNull();
    expect(svg.getAttribute("title")).toBeNull();
  });

  it("themes from currentColor and data-accent, never a hard-coded tone", () => {
    // A hex or rgba in the component would be a dark-theme contrast failure
    // waiting to happen — the /how-it-works illustrations set this precedent.
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(src).not.toMatch(/rgb\(/);
    expect(src).toMatch(/currentColor/);
    // Three stages, each carrying an accent so they are not all one colour.
    expect(src).toMatch(/data-accent="blue"/);
    expect(src).toMatch(/data-accent="violet"/);
    expect(src).toMatch(/data-accent="green"/);
  });

  it("has no external reference — the arrow marker is defined inline", () => {
    const { container } = render(<FlowIllustration />);
    // Every marker reference must resolve to a marker defined in this figure.
    // `url(#flow-arrow)` is a fragment reference to an element in the same
    // document, not a fetch — the point is that nothing points off-page.
    const markers = new Set([...container.querySelectorAll("marker")].map((m) => m.id));
    const refs = [...container.querySelectorAll("[marker-end]")].map((el) =>
      el.getAttribute("marker-end")!,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const id = ref.match(/^url\(#(.+)\)$/)?.[1];
      expect(id, `${ref} is not a local fragment reference`).toBeTruthy();
      expect(markers.has(id!), `marker #${id} is not defined in the figure`).toBe(true);
    }
    // And nothing references an absolute or protocol-relative URL.
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/(?:src|href|xlink:href)=/);
  });

  it("declares no external <image> element", () => {
    const { container } = render(<FlowIllustration />);
    expect(container.querySelector("image")).toBeNull();
  });
});

describe("landing page illustration", () => {
  const landing = readFileSync(resolve(process.cwd(), "src", "pages", "LandingPage.tsx"), "utf8");

  it("uses it in the how-it-works section", () => {
    expect(landing).toMatch(/<FlowIllustration\s*\/>/);
  });
});
