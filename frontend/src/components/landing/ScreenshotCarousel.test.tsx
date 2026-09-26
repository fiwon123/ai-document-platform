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
});