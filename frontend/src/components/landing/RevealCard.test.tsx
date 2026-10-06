/**
 * `RevealCard` must actually reveal.
 *
 * The first attempt at the equal-height landing rows put `className="reveal-card"`
 * on the `<article>` in `LandingPage` and deleted the `<Reveal>` wrapper. That
 * looks right and passes a source-shape test, but `is-revealed` is applied by
 * JavaScript — `useScrollReveal` is what flips it, and the only code that called
 * it on these cards was `Reveal` itself. So the cards sat at `opacity: 0`
 * permanently: 9 of them, invisible at every width and in both themes, and a
 * ~1,100px empty band where the feature grids used to be.
 *
 * Reduced motion hid it completely, because `useScrollReveal` reports visible
 * when no animation is possible — so under `prefers-reduced-motion` the page was
 * correct and everywhere else it was empty. These tests render for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RevealCard } from "./RevealCard";
import { LandingPage } from "../../pages/LandingPage";

// LandingPage reads the auth context for its hero CTAs. Stubbed, not wrapped:
// what is under test is the feature cards, and the real provider would only add
// token/refresh fetches around them.
vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, login: vi.fn(), logout: vi.fn() }),
}));

/** Drives the IntersectionObserver the reveal hook installs. */
class MockObserver {
  static instances: MockObserver[] = [];
  callback: IntersectionObserverCallback;
  disconnected = false;
  /** The elements this observer was pointed at, so a test can reveal the card
   * it actually belongs to rather than whichever observer mounted last. */
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    MockObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** Report the observed element as having entered the viewport. */
  enter(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }

  /** The observer watching `element` — each card has its own, so a test that
   * reveals cards one at a time must not fire a neighbour's observer. */
  static for_(element: Element): MockObserver {
    const found = MockObserver.instances.find((o) => o.observed.includes(element));
    if (!found) throw new Error("no observer is watching that element");
    return found;
  }
}

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      matches: q.includes("prefers-reduced-motion") ? matches : false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("RevealCard", () => {
  beforeEach(() => {
    MockObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockObserver);
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders an article carrying the reveal classes and the accent", () => {
    render(
      <RevealCard className="landing-card" accent="violet" delay={120}>
        <h3>Blazing fast</h3>
      </RevealCard>,
    );
    const card = screen.getByRole("heading", { name: "Blazing fast" }).closest("article");
    expect(card).not.toBeNull();
    expect(card!.className).toContain("reveal-card");
    expect(card!.className).toContain("landing-card");
    expect(card!.getAttribute("data-accent")).toBe("violet");
    // Starts hidden, because the CSS only reveals on `is-revealed`.
    expect(card!.className).not.toContain("is-revealed");
  });

  it("flips to is-revealed when the card scrolls into view", () => {
    render(
      <RevealCard className="landing-card">
        <h3>Bulk upload</h3>
      </RevealCard>,
    );
    const card = screen.getByRole("heading", { name: "Bulk upload" }).closest("article")!;
    expect(card.className).not.toContain("is-revealed");

    const observer = MockObserver.instances.at(-1)!;
    act(() => observer.enter(card));

    // This is the assertion that was missing when the cards shipped invisible.
    expect(card.className).toContain("is-revealed");
  });

  it("passes the stagger delay through as a CSS custom property", () => {
    render(
      <RevealCard delay={150}>
        <h3>Export results</h3>
      </RevealCard>,
    );
    const card = screen.getByRole("heading", { name: "Export results" }).closest("article")!;
    expect(card.style.getPropertyValue("--reveal-delay")).toBe("150ms");
  });

  it("renders visible immediately under prefers-reduced-motion, with no observer", () => {
    mockReducedMotion(true);
    render(
      <RevealCard className="landing-card">
        <h3>Private by design</h3>
      </RevealCard>,
    );
    const card = screen.getByRole("heading", { name: "Private by design" }).closest("article")!;
    expect(card.className).toContain("is-revealed");
    // No observer is created when the animation is not possible.
    expect(MockObserver.instances).toHaveLength(0);
  });

  it("adds no wrapper element, so the card stays a grid item that stretches", () => {
    const { container } = render(
      <RevealCard className="landing-card">
        <h3>Upload anything</h3>
      </RevealCard>,
    );
    // The <article> is the root the component renders — no div around it.
    expect(container.firstElementChild!.tagName).toBe("ARTICLE");
  });
});

describe("landing feature cards", () => {
  beforeEach(() => {
    MockObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", MockObserver);
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders every core and secondary feature card as a revealed-on-view article", async () => {
    const { CORE_FEATURES, SECONDARY_FEATURES } = await import("../../content/marketing");
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    for (const feature of [...CORE_FEATURES, ...SECONDARY_FEATURES]) {
      const card = screen.getByRole("heading", { name: feature.title }).closest(".reveal-card");
      expect(card, `${feature.title} is not a reveal card`).not.toBeNull();
      // Each card owns its own observer, so each reveals independently.
      act(() => MockObserver.for_(card!).enter(card!));
      expect(
        card!.className,
        `${feature.title} never received is-revealed, so it stays at opacity 0`,
      ).toContain("is-revealed");
    }
  });

  it("renders six secondary cards, so no row can be left partial", async () => {
    const { SECONDARY_FEATURES } = await import("../../content/marketing");
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );
    // 6 divides by 3, 2 and 1 — the reason a sixth card was added (#580).
    expect(SECONDARY_FEATURES).toHaveLength(6);
    for (const f of SECONDARY_FEATURES) {
      expect(screen.getByRole("heading", { name: f.title })).toBeTruthy();
    }
  });
});
