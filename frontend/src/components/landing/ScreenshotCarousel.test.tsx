import { act, fireEvent, render, screen } from "@testing-library/react";
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
});