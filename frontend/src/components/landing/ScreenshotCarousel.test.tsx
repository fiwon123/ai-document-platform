import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenshotCarousel, type CarouselSlide } from "./ScreenshotCarousel";

const SLIDES: CarouselSlide[] = [
  { src: "/screenshots/dashboard.png", alt: "Dashboard view", caption: "Dashboard" },
  { src: "/screenshots/search.png", alt: "Search results", caption: "Search" },
];

let matchMediaMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  matchMediaMock = vi.fn().mockReturnValue({ matches: false });
  vi.stubGlobal("matchMedia", matchMediaMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ScreenshotCarousel", () => {
  it("renders all slides as images with captions (inactive slides are aria-hidden)", () => {
    const { container } = render(<ScreenshotCarousel slides={SLIDES} />);
    expect(container.querySelectorAll(".carousel-slide img")).toHaveLength(2);
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Search")).toBeTruthy();
  });

  it("marks only the active slide as visible", () => {
    render(<ScreenshotCarousel slides={SLIDES} />);
    const activeFigure = screen
      .getAllByRole("img")
      .find((img) => img.closest("figure")?.classList.contains("active"));
    expect(activeFigure).toBeTruthy();
  });

  it("advances automatically after the interval", async () => {
    vi.useFakeTimers();
    render(<ScreenshotCarousel slides={SLIDES} intervalMs={2000} />);
    expect(screen.getByLabelText("Go to slide 1").getAttribute("aria-current")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByLabelText("Go to slide 2").getAttribute("aria-current")).toBe("true");
  });

  it("does not auto-advance when paused on hover", async () => {
    vi.useFakeTimers();
    render(<ScreenshotCarousel slides={SLIDES} intervalMs={2000} />);
    fireEvent.mouseEnter(screen.getByRole("group", { name: "Product screenshots" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByLabelText("Go to slide 1").getAttribute("aria-current")).toBe("true");
  });

  it("navigates with the arrow buttons and wraps around", () => {
    render(<ScreenshotCarousel slides={SLIDES} />);
    fireEvent.click(screen.getByLabelText("Previous screenshot"));
    expect(screen.getByLabelText("Go to slide 2").getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByLabelText("Next screenshot"));
    expect(screen.getByLabelText("Go to slide 1").getAttribute("aria-current")).toBe("true");
  });

  it("jumps to a slide via its dot", () => {
    render(<ScreenshotCarousel slides={SLIDES} />);
    fireEvent.click(screen.getByLabelText("Go to slide 2"));
    expect(screen.getByLabelText("Go to slide 2").getAttribute("aria-current")).toBe("true");
  });

  it("disables auto-advance for reduced-motion users", async () => {
    matchMediaMock.mockReturnValue({ matches: true });
    vi.useFakeTimers();
    render(<ScreenshotCarousel slides={SLIDES} intervalMs={2000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.getByLabelText("Go to slide 1").getAttribute("aria-current")).toBe("true");
  });

  it("groups the dots without claiming the ARIA tabs pattern", () => {
    // role="tablist" obliges the children to be role="tab" and requires
    // matching tabpanels, roving tabindex and arrow-key handling. The dots are
    // plain buttons switching a single visible slide, so declaring a tablist was
    // a claim the markup did not keep and it failed aria-required-children.
    // `group` names the set without demanding a child role.
    const { container } = render(<ScreenshotCarousel slides={SLIDES} />);
    const dots = container.querySelector(".carousel-dots");
    expect(dots?.getAttribute("role")).toBe("group");
    expect(dots?.getAttribute("aria-label")).toBe("Choose screenshot");
    // No ARIA role may demand a specific child role unless the children have it.
    const REQUIRED_CHILD_ROLES: Record<string, string> = {
      tablist: "tab",
      listbox: "option",
      menu: "menuitem",
      radiogroup: "radio",
      tree: "treeitem",
    };
    for (const el of container.querySelectorAll("[role]")) {
      const required = REQUIRED_CHILD_ROLES[el.getAttribute("role") ?? ""];
      if (!required) continue;
      for (const child of el.children) {
        expect(
          child.getAttribute("role"),
          `${el.getAttribute("role")} child must be role="${required}"`,
        ).toBe(required);
      }
    }
  });

  it("renders nothing for an empty slide set", () => {
    const { container } = render(<ScreenshotCarousel slides={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives each dot a 24x24 target while keeping the visible dot at 8px", () => {
    // WCAG 2.5.8 Target Size (Minimum) failed on the dots at 8x8. The target
    // is the <button>, not the 8px dot inside it, so the button has to carry
    // the 24x24 box — an absolutely positioned ::before would widen the
    // clickable area without changing the bounding box the audit measures.
    //
    // jsdom does not lay out, so this reads the stylesheet: the declarations
    // are the only thing standing between the dots and a target-size failure.
    const css = readFileSync(resolve(__dirname, "../../App.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const body = (selector: string): string => {
      const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) =>
        (m[1] ?? "").split(",").some((s) => s.trim() === selector),
      );
      if (!rule) throw new Error(`no ${selector} rule in App.css`);
      return rule[2] ?? "";
    };
    const px = (declarations: string, property: string, selector: string): number => {
      const m = declarations.match(new RegExp(`${property}\\s*:\\s*([^;]+)`));
      const raw = m?.[1]?.trim();
      if (!raw) {
        throw new Error(
          `${selector} declares no ${property}, so the dot has no ${property} and its ` +
            `target is smaller than WCAG 2.5.8's 24px minimum`,
        );
      }
      const n = raw.match(/^(\d+(?:\.\d+)?)px$/);
      if (!n?.[1]) throw new Error(`${selector} ${property} is "${raw}", not a px length`);
      return Number(n[1]);
    };

    const target = body(".carousel-dot");
    expect(px(target, "width", ".carousel-dot"), "dot target width").toBeGreaterThanOrEqual(24);
    expect(px(target, "height", ".carousel-dot"), "dot target height").toBeGreaterThanOrEqual(24);
    // The button is 24px with no padding/border, so the box it exposes to the
    // audit is exactly that.
    expect(target).toMatch(/padding\s*:\s*0/);
    expect(target).toMatch(/border\s*:\s*none/);

    // The appearance must not change to satisfy the audit: the visible dot
    // stays 8px, centred inside the larger target (centering verified in the
    // browser — 10px when the active dot's scale(1.25) is applied).
    expect(px(body(".carousel-dot span"), "width", ".carousel-dot span")).toBe(8);
    expect(px(body(".carousel-dot span"), "height", ".carousel-dot span")).toBe(8);
    expect(target).toMatch(/place-items\s*:\s*center/);
  });

  it("stacks the caption above the dot row on narrow viewports", () => {
    // The caption is left-anchored and the dot row is centred in the slide, and
    // the caption's width comes from its text, so as the slide narrows the
    // centred row runs into the caption: measured in Chromium, 4 of 4 dots sat
    // on the caption at 320px, 3 at 375/414px, 2 at 480px, 1 at 520/560px. Both
    // live in the same vertical band, so document order decided which won.
    //
    // The fix stacks the band rather than narrowing the caption, so the two
    // occupy disjoint vertical ranges and no caption text can collide at any
    // width. This guard pins that *relationship* (caption bottom >= the top of
    // the dot row), not the literal 36px — a value pin would break on an
    // intentional tweak, and the relationship is the actual defect.
    //
    // jsdom does not lay out, so this reads the stylesheet; the browser pass is
    // the real evidence (0 of 4 overlapping at 320/375/414/480px).
    const css = readFileSync(resolve(__dirname, "../../App.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const body = (selector: string, scope = css): string => {
      const rule = [...scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) =>
        (m[1] ?? "").split(",").some((s) => s.trim() === selector),
      );
      if (!rule) throw new Error(`no ${selector} rule in App.css`);
      return rule[2] ?? "";
    };
    const px = (declarations: string, property: string, selector: string): number => {
      const m = declarations.match(new RegExp(`${property}\\s*:\\s*([^;]+)`));
      const raw = m?.[1]?.trim();
      if (!raw) throw new Error(`${selector} declares no ${property}`);
      const n = raw.match(/^(\d+(?:\.\d+)?)px$/);
      if (!n?.[1]) throw new Error(`${selector} ${property} is "${raw}", not a px length`);
      return Number(n[1]);
    };

    // Geometry of the row the caption has to clear, read from the base rules so
    // the guard follows #427 if the 24x24 target is ever resized.
    const dotsBottom = px(body(".carousel-dots"), "bottom", ".carousel-dots");
    const dotHeight = px(body(".carousel-dot"), "height", ".carousel-dot");
    const dotRowTop = dotsBottom + dotHeight;

    // Find the narrow-viewport block that repositions the caption. Each
    // @media is scoped to its OWN body by brace matching: a fixed character
    // window would let the preceding (wider) query swallow this one and report
    // its threshold instead.
    const mediaBlocks = (sheet: string): { query: string; width: number; body: string }[] => {
      const found: { query: string; width: number; body: string }[] = [];
      const re = /@media\s*\(max-width:\s*(\d+(?:\.\d+)?)px\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sheet))) {
        const open = sheet.indexOf("{", m.index + m[0].length);
        if (open === -1) continue;
        let depth = 0;
        let end = open;
        for (let i = open; i < sheet.length; i++) {
          if (sheet[i] === "{") depth++;
          else if (sheet[i] === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        found.push({ query: m[0], width: Number(m[1]), body: sheet.slice(open + 1, end) });
      }
      return found;
    };

    const narrow = mediaBlocks(css).find((b) => /(\.carousel-caption\s*\{[^}]*\})/.test(b.body));
    if (!narrow) {
      throw new Error(
        "no max-width block repositions .carousel-caption, so the centred dot row " +
          "overlaps the caption below ~580px (4 of 4 dots at 320px)",
      );
    }
    const threshold = narrow.width;
    const captionBottom = px(body(".carousel-caption", narrow.body), "bottom", ".carousel-caption");

    expect(
      captionBottom,
      `caption bottom (${captionBottom}px) must be at or above the top of the dot row ` +
        `(${dotRowTop}px = ${dotsBottom}px bottom + ${dotHeight}px target)`,
    ).toBeGreaterThanOrEqual(dotRowTop);

    // The block has to cover the widths where they actually collide (the issue
    // lists 480px as the widest) and stop before the desktop layout the criteria
    // require to be unchanged. 580px is where the row first clears the caption —
    // by 0.9px — so anything from 480 up to 640 exclusive is acceptable here.
    expect(threshold, "must cover the colliding widths").toBeGreaterThanOrEqual(480);
    expect(threshold, "must leave the 640px+ desktop layout alone").toBeLessThan(640);

    // Desktop keeps its own position: the base rule still positions the caption
    // itself, so nothing above lifted it out of the lower band by default.
    expect(px(body(".carousel-caption"), "bottom", ".carousel-caption")).toBeGreaterThan(0);
  });
});
