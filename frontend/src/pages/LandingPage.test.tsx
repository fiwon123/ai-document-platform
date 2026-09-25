import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user }),
}));

let user: { username: string; role: string } | null;

function renderPage() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  user = null;
});

describe("LandingPage", () => {
  it("renders hero, features, how-it-works, pricing, and footer sections", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Find and ask anything",
    );
    expect(screen.getByText("Upload anything")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pricing that grows with you" })).toBeTruthy();
    expect(screen.getByText("Compare plans")).toBeTruthy();
    expect(screen.getByText("AI Document Intelligence Platform")).toBeTruthy();
  });

  it("offers demo and registration CTAs to anonymous visitors", () => {
    renderPage();
    expect(screen.getAllByRole("link", { name: "Try the live demo" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Create free account" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("No credit card required. Try it without an account.").length).toBeGreaterThan(0);
  });

  it("lists three plans with differing limits", () => {
    renderPage();
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pro").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Enterprise").length).toBeGreaterThan(0);
    // Comparison table shows a free-tier limitation vs pro unlimited
    expect(screen.getByText("10 / month")).toBeTruthy();
    expect(screen.getAllByText("Unlimited").length).toBeGreaterThan(0);
  });

  it("points signed-in visitors to their workspace instead of sign-up", () => {
    user = { username: "alice", role: "customer" };
    renderPage();
    expect(screen.queryByText("Create free account")).toBeNull();
    const workspaceLinks = screen.getAllByRole("link", { name: "Go to your workspace" });
    expect(workspaceLinks.length).toBeGreaterThan(0);
    workspaceLinks.forEach((link) => {
      expect(link.getAttribute("href")).toBe("/app");
    });
    expect(screen.getAllByText("Open workspace").length).toBeGreaterThan(0);
    expect(screen.queryByText("No credit card required. Try it without an account.")).toBeNull();
  });

  it("shows a product-screenshot carousel in the hero", () => {
    renderPage();
    const carousel = screen.getByRole("group", {
      name: "AskDocs product screenshots",
    });
    expect(carousel).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Go to slide 1")).toBeTruthy();
  });

  it("shows social proof: logos, stats, and trust badges", () => {
    renderPage();
    expect(screen.getByText("Trusted by teams who ship")).toBeTruthy();
    // The marquee track is duplicated for the seamless loop.
    expect(screen.getAllByText("Northwind").length).toBeGreaterThan(0);
    expect(screen.getByText("Documents processed")).toBeTruthy();
    expect(screen.getByText("Questions answered")).toBeTruthy();
    expect(screen.getByText("Search uptime")).toBeTruthy();
    expect(screen.getByText("SOC 2 ready")).toBeTruthy();
    expect(screen.getByText("GDPR compliant")).toBeTruthy();
  });

  it("gives each stat its own accent colour", () => {
    // The three figures used to share one blue->violet gradient, so they read
    // as three copies of the same number. They now declare data-accent and take
    // --card-accent from the same accent system the cards use, which is what
    // makes them distinguishable — and what makes dark mode work here without a
    // dedicated rule.
    renderPage();
    const items = document.querySelectorAll(".stat-item");
    expect(items.length).toBe(3);
    expect([...items].map((i) => i.getAttribute("data-accent"))).toEqual([
      "blue",
      "violet",
      "green",
    ]);
  });

  it("staggers the stat counts so the row completes left to right", () => {
    // The three figures scroll into view together and start counting together;
    // the stagger comes from durationMs, which must therefore *increase* left
    // to right. The easing is symmetric, so a shorter run is a genuinely
    // earlier arrival, and App.css scales each number up 1.12em while it
    // counts — so the leftmost settles and shrinks back first, and the eye is
    // walked across the row rather than handed three numbers that land at once.
    //
    // This asserts the ordering, not the literals, so retuning the timings does
    // not break it. A render test cannot see it: the durations are consumed by
    // the interval, and the same three final strings appear either way.
    const source = readFileSync(
      resolve(process.cwd(), "src", "pages", "LandingPage.tsx"),
      "utf8",
    );
    const durations = [
      ...source.matchAll(/<CountUp\b[^>]*durationMs=\{(\d+)\}/g),
    ].map((m) => Number(m[1]));

    expect(durations).toHaveLength(3);
    // Strictly increasing: equal durations collapse the stagger back into a
    // single simultaneous landing, which is the regression being guarded.
    expect(durations[0]).toBeLessThan(durations[1]!);
    expect(durations[1]).toBeLessThan(durations[2]!);
    // A gap too small to perceive is no better than none — under ~150ms the
    // three completions blur into one event and the ordering stops reading.
    expect(durations[1]! - durations[0]!).toBeGreaterThanOrEqual(150);
    expect(durations[2]! - durations[1]!).toBeGreaterThanOrEqual(150);
  });

  it("labels the illustrative stats honestly as sample data", () => {
    renderPage();
    expect(
      screen.getByText(
        "Sample figures shown for illustration — your workspace shows your real numbers.",
      ),
    ).toBeTruthy();
  });

  it("keeps the logo marquee loop seamless by triplicating every mark", () => {
    // The user asked to keep the marquee animation, so the -33.333% loop
    // depends on the track being an exact tripling of the logo list. If the
    // strip is ever de-duplicated the marquee visibly jumps at the wrap point.
    // The copy count and the keyframe percentage must be changed together.
    const { container } = renderPage();
    const strip = container.querySelector(".logo-strip")!;
    const marks = [...strip.querySelectorAll(".logo-mark")].map(
      (m) => m.textContent,
    );
    const third = marks.length / 3;
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length % 3).toBe(0);
    expect(marks.slice(0, third)).toEqual(marks.slice(third, third * 2));
    expect(marks.slice(third, third * 2)).toEqual(marks.slice(third * 2));
  });

  it("gives the closing CTA band a supporting line under the heading", () => {
    renderPage();
    const band = document.querySelector(".landing-cta-band")!;
    expect(band.querySelector("h2")?.textContent).toBe(
      "Ready to find answers in your documents?",
    );
    expect(
      band.querySelector(".landing-cta-band-sub")?.textContent,
    ).toContain("first three documents are free");
  });

  it("organizes features into core and secondary groups", () => {
    renderPage();
    expect(screen.getByText("Core capabilities")).toBeTruthy();
    expect(screen.getByText("More to explore")).toBeTruthy();
    // Core trio renders as its own cards
    expect(screen.getAllByText("Upload anything").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Semantic search").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ask your documents").length).toBeGreaterThan(0);
  });

  it("extended features list (8 cards) renders with icons", () => {
    renderPage();
    // Feature cards AND comparison-table rows share several names, so these
    // assertions include both occurrences.
    expect(screen.getAllByText("Bulk upload").length).toBeGreaterThan(0);
    expect(screen.getByText("Export results")).toBeTruthy();
    expect(screen.getAllByText("Webhook notifications").length).toBeGreaterThan(0);
    expect(screen.getByText("Blazing fast")).toBeTruthy();
  });

  it("switches plan card pricing between monthly and annual", () => {
    renderPage();
    expect(screen.getAllByText(/per month/).length).toBeGreaterThan(0);
    expect(screen.getByText("$12")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Toggle annual billing"));
    expect(screen.getByText("$10")).toBeTruthy();
    expect(screen.getByText("Save 17%")).toBeTruthy();
  });

  it("expands and collapses FAQ answers", () => {
    renderPage();
    const button = screen.getByRole("button", { name: /Is there a free plan/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders a full footer with navigation, newsletter, and social links", () => {
    renderPage();
    expect(screen.getByText("Stay in the loop")).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Product" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Company" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeTruthy();
    expect(screen.getByLabelText("AskDocs on GitHub")).toBeTruthy();
    expect(screen.getByText("Made for people who love their documents.")).toBeTruthy();
  });

  it("keeps only GitHub as a link and makes the missing accounts inert", () => {
    renderPage();
    const github = screen.getByLabelText("AskDocs on GitHub") as HTMLAnchorElement;
    expect(github.href).toBe("https://github.com/fiwon123/ai-document-platform");
    expect(github.target).toBe("_blank");

    // Twitter and LinkedIn used to render as <a href="/#"> — a link that went
    // nowhere. They are now non-interactive blocks: no href, no tab stop, no
    // click handler, so there is nothing for a keyboard user to activate.
    for (const network of ["Twitter", "LinkedIn"] as const) {
      const placeholder = screen.getByLabelText(
        new RegExp(`AskDocs on ${network}`),
      );
      expect(placeholder.tagName).not.toBe("A");
      expect(placeholder).not.toHaveAttribute("href");
      expect(placeholder).not.toHaveAttribute("tabindex");
      expect(placeholder.getAttribute("data-coming-soon")).toBe("true");
      expect(placeholder.getAttribute("title")).toBe("Coming soon");
      expect(screen.queryByRole("link", { name: new RegExp(network) })).toBeNull();
    }
  });

  it("links every footer column to a real route instead of the home page", () => {
    renderPage();
    const hrefsIn = (label: string) =>
      within(screen.getByRole("navigation", { name: label }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"));

    expect(hrefsIn("Product")).toEqual([
      "/product",
      "/features",
      "/how-it-works",
      "/pricing",
      "/demo",
    ]);
    expect(hrefsIn("Company")).toEqual([
      "/company",
      "/about",
      "/blog",
      "/careers",
      "/contact",
    ]);    // The old footer pointed every Legal link at "/", so a visitor could never
    // leave the landing page from there.
    expect(hrefsIn("Legal")).toEqual([
      "/privacy",
      "/terms",
      "/security",
      "/gdpr",
    ]);
  });

  /* The accent system (#377) drives every per-card color from a
     data-accent attribute, so these assert the attribute is present and
     correct — the actual colors live in App.css keyed off the same name. */

  it("tags each core feature card with its own accent", () => {
    renderPage();
    const grid = document.querySelector(".landing-grid-core") as HTMLElement;
    const card = (title: string) =>
      within(grid).getByText(title).closest("article") as HTMLElement;

    expect(card("Upload anything").dataset.accent).toBe("blue");
    expect(card("Semantic search").dataset.accent).toBe("violet");
    expect(card("Ask your documents").dataset.accent).toBe("green");
  });

  it("tags each secondary feature card with an accent", () => {
    renderPage();
    // Scoped to the grid: "Bulk upload" and "Webhook notifications" also
    // appear as rows in the pricing comparison table.
    const grid = document.querySelector(".landing-grid-secondary") as HTMLElement;
    const card = (title: string) =>
      within(grid).getByText(title).closest("article") as HTMLElement;

    expect(card("Private by design").dataset.accent).toBe("blue");
    expect(card("Blazing fast").dataset.accent).toBe("amber");
    expect(card("Bulk upload").dataset.accent).toBe("violet");
    expect(card("Export results").dataset.accent).toBe("green");
    expect(card("Webhook notifications").dataset.accent).toBe("rose");
  });

  it("tags each how-it-works step with its accent in order", () => {
    renderPage();
    const steps = Array.from(
      document.querySelectorAll(".landing-step"),
    ) as HTMLElement[];

    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.dataset.accent)).toEqual(["blue", "violet", "green"]);
  });

  it("marks the featured plan column header in the comparison table", () => {
    renderPage();
    const proHead = document.querySelector(".landing-table th.pro-head");
    expect(proHead?.textContent).toBe("Pro");
  });

  it("wraps each trust badge check in its own tinted disc", () => {
    renderPage();
    // "Included" is the shared aria-label on the check glyph; the pricing
    // table uses the same icon, so scope the query to the badge list.
    const badges = Array.from(
      document.querySelectorAll(".trust-badges li"),
    ) as HTMLElement[];

    expect(badges).toHaveLength(4);
    for (const badge of badges) {
      expect(badge.querySelector(".trust-badge-check")).toBeTruthy();
    }
  });
});