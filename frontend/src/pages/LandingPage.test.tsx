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

  it("labels the illustrative stats honestly as sample data", () => {
    renderPage();
    expect(
      screen.getByText(
        "Sample figures shown for illustration — your workspace shows your real numbers.",
      ),
    ).toBeTruthy();
  });

  it("keeps the logo marquee loop seamless by duplicating every mark", () => {
    // The user asked to keep the marquee animation, so the -50% loop depends
    // on the track being an exact doubling of the logo list. If the strip is
    // ever de-duplicated the marquee visibly jumps at the wrap point.
    const { container } = renderPage();
    const strip = container.querySelector(".logo-strip")!;
    const marks = [...strip.querySelectorAll(".logo-mark")].map(
      (m) => m.textContent,
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length % 2).toBe(0);
    expect(marks.slice(0, marks.length / 2)).toEqual(
      marks.slice(marks.length / 2),
    );
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

  it("points the GitHub social to the repository and marks the rest coming-soon", () => {
    renderPage();
    const github = screen.getByLabelText("AskDocs on GitHub") as HTMLAnchorElement;
    expect(github.href).toBe("https://github.com/fiwon123/ai-document-platform");
    expect(github.target).toBe("_blank");

    const twitter = screen.getByLabelText("AskDocs on Twitter") as HTMLAnchorElement;
    expect(twitter.getAttribute("data-coming-soon")).toBe("true");
    expect(twitter.title).toBe("Coming soon");

    const linkedin = screen.getByLabelText("AskDocs on LinkedIn") as HTMLAnchorElement;
    expect(linkedin.getAttribute("data-coming-soon")).toBe("true");
    expect(linkedin.title).toBe("Coming soon");
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