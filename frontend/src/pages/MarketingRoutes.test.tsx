import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import {
  MARKETING_ROUTES,
  MARKETING_ROUTE_LABELS,
  NAV_COMPANY,
  NAV_LEGAL,
  NAV_PRODUCT,
} from "../content/marketing";

/* The real App is rendered so the route table under test is App's, not a copy
   of it. A mirrored route tree (see AppRoutes.test.tsx) proves the shape of
   the contract but not that App honours it; here a page that exists but is
   never registered fails the test.

   Every page is lazy-loaded, so assertions await the Suspense boundary rather
   than the loading fallback. */
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }),
}));

vi.mock("../services/api", () => ({
  api: {
    getCurrentUser: vi.fn().mockRejectedValue(new Error("anonymous")),
  },
}));

async function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const view = render(<App />);
  await waitFor(() =>
    expect(view.container.querySelector(".loading")).toBeNull(),
  );
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("marketing routes", () => {
  it("registers every route the navigation advertises", () => {
    const source = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    // The list in content/marketing.ts is the contract; App must actually mount
    // each path, otherwise a footer link leads to the 404 page.
    for (const route of MARKETING_ROUTES) {
      if (route === "/") continue;
      expect(source).toContain(`path="${route}"`);
    }
  });

  it.each(MARKETING_ROUTES.filter((route) => route !== "/"))(
    "renders %s with a heading under the right section",
    async (route) => {
      await renderAt(route);
      const h1 = await screen.findByRole("heading", { level: 1 });
      expect(h1.textContent?.trim().length).toBeGreaterThan(0);

      // The eyebrow is the section label, so a page filed under Product cannot
      // drift into reading as a Legal or Company page.
      if (MARKETING_ROUTE_LABELS[route] === "Live demo") return;
      const section = route.startsWith("/product") || /features|how-it-works|pricing/.test(route)
        ? "Product"
        : /privacy|terms|security|gdpr/.test(route)
          ? "Legal"
          : "Company";
      expect(screen.getByText(section, { selector: ".landing-eyebrow" })).toBeTruthy();
    },
  );

  it("uses the documented headings so pages keep their identity", async () => {
    // The section eyebrow alone would pass for a dozen pages; the titles are
    // what a visitor actually reads, so pin the ones that carry the argument.
    const expected: Record<string, RegExp> = {
      "/product": /private workspace/i,
      "/features": /everything you need/i,
      "/how-it-works": /upload to grounded answer/i,
      "/pricing": /grows with you/i,
      "/company": /people behind askdocs/i,
      "/about": /about askdocs/i,
      "/blog": /blog/i,
      "/careers": /careers/i,
      "/contact": /contact/i,
      "/privacy": /privacy/i,
      "/terms": /terms of service/i,
      "/security": /security/i,
      "/gdpr": /gdpr/i,
      "/demo": /try the demo/i,
    };
    for (const [path, pattern] of Object.entries(expected)) {
      const view = await renderAt(path);
      expect(view.container.querySelector("h1")?.textContent).toMatch(pattern);
      view.unmount();
    }
  });

  it("frames every public page with the marketing navbar and footer", async () => {
    for (const route of ["/product", "/about", "/privacy"]) {
      const view = await renderAt(route);
      expect(within(view.container).getByLabelText("AskDocs home")).toBeTruthy();
      expect(
        within(view.container).getByRole("navigation", { name: "Legal" }),
      ).toBeTruthy();
      view.unmount();
    }
  });

  it("does not 404 any advertised navigation destination", async () => {
    const paths = [
      ...NAV_PRODUCT.map((item) => item.to),
      ...NAV_COMPANY.map((item) => item.to),
      ...NAV_LEGAL.map((item) => item.to),
      "/product",
      "/company",
    ];
    for (const path of paths) {
      const view = await renderAt(path);
      expect(view.container.textContent).not.toContain(
        "This page could not be found.",
      );
      view.unmount();
    }
  });
});

describe("legal pages", () => {
  it("flags each document as a template needing review", async () => {
    for (const { to } of NAV_LEGAL) {
      const view = await renderAt(to);
      // Publishing unreviewed legal text as though it were settled advice is
      // the failure mode this notice exists to prevent.
      expect(view.container.querySelector(".template-notice")).not.toBeNull();
      expect(view.container.textContent).toMatch(/template/i);
      view.unmount();
    }
  });

  it("shows an updated date and names the entity it covers", async () => {
    await renderAt("/privacy");
    expect(screen.getByText(/Last updated/)).toBeTruthy();
    expect(screen.getAllByText(/AskDocs/).length).toBeGreaterThan(0);
  });

  it("states the limits rather than overclaiming assurance", async () => {
    await renderAt("/security");
    // No SOC 2 report is held; the page has to say so instead of implying one.
    expect(screen.getByText(/SOC 2/i).textContent).toMatch(/not yet|do not yet/i);
  });
});

describe("plan comparison", () => {
  it("gives every included/excluded cell readable text, not just an icon", async () => {
    const view = await renderAt("/pricing");
    const table = view.container.querySelector(".landing-table") as HTMLElement;
    expect(table).not.toBeNull();

    const body = table.querySelector("tbody") as HTMLElement;
    const rows = body.querySelectorAll("tr");
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const feature = row.querySelector("th")?.textContent ?? "";
      const cells = row.querySelectorAll("td");
      for (const cell of cells) {
        const text = cell.textContent?.trim() ?? "";
        const hasIcon = cell.querySelector("svg") !== null;
        if (hasIcon) {
          // A tick or cross with no text announces as an empty cell, which in a
          // limits table reads as "no data" instead of a yes/no answer.
          expect(text.length).toBeGreaterThan(0);
        }
        expect(text).not.toBe("undefined");
        expect(feature.length).toBeGreaterThan(0);
      }
    }
  });

  it("states inclusion and exclusion in words", async () => {
    const view = await renderAt("/pricing");
    const text = view.container.textContent ?? "";
    expect(text).toMatch(/Included/);
    expect(text).toMatch(/Not included/);
  });
});

describe("contact page", () => {
  it("offers a working GitHub route and an email link", async () => {
    const view = await renderAt("/contact");
    // Scoped to the page body: the footer carries its own GitHub social, which
    // would otherwise satisfy a loose query and prove nothing about Contact.
    const body = within(view.container.querySelector(".page-body") as HTMLElement);
    const github = body.getByRole("link", { name: /github/i });
    expect(github.getAttribute("href")).toContain("github.com/fiwon123");

    // The email channels are labelled with the address itself, so assert on the
    // href scheme rather than on a name that may change.
    const mailtos = body
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("mailto:"));
    expect(mailtos.length).toBeGreaterThan(0);
  });

  it("points issue and repository links somewhere real", async () => {
    const view = await renderAt("/contact");
    const body = within(view.container.querySelector(".page-body") as HTMLElement);
    const hrefs = body
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "");
    for (const href of hrefs) {
      // No dead links, and nothing left pointing at the bare home page.
      expect(href).not.toBe("");
      expect(href).not.toBe("/");
      expect(href).not.toBe("/#");
    }
  });
});

describe("blog page", () => {
  it("says there is nothing published instead of faking posts", async () => {
    const view = await renderAt("/blog");
    expect(view.container.textContent).toMatch(/nothing published|not published|yet/i);
    // A fake article grid is worse than an honest empty state.
    expect(view.container.querySelectorAll("article").length).toBe(0);
  });
});

describe("navigation coverage", () => {
  it("offers a hub plus every child page for each section", async () => {
    await renderAt("/");

    const footerProduct = within(screen.getByRole("navigation", { name: "Product" }));
    expect(
      footerProduct.getByRole("link", { name: "Overview" }).getAttribute("href"),
    ).toBe("/product");
    for (const item of NAV_PRODUCT) {
      expect(
        footerProduct.getByRole("link", { name: item.label }).getAttribute("href"),
      ).toBe(item.to);
    }

    const footerCompany = within(
      screen.getByRole("navigation", { name: "Company" }),
    );
    expect(
      footerCompany.getByRole("link", { name: "Overview" }).getAttribute("href"),
    ).toBe("/company");
    for (const item of NAV_COMPANY) {
      expect(
        footerCompany.getByRole("link", { name: item.label }).getAttribute("href"),
      ).toBe(item.to);
    }

    const footerLegal = within(screen.getByRole("navigation", { name: "Legal" }));
    for (const item of NAV_LEGAL) {
      expect(
        footerLegal.getByRole("link", { name: item.label }).getAttribute("href"),
      ).toBe(item.to);
    }
  });
});
