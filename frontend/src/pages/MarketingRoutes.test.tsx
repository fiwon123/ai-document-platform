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

  // #461: the public catch-all rendered the 404 bare — nav=0, footer=0 — so it
  // was the one public route with no way back into the site. Checked against the
  // real App (not the mirrored tree in AppRoutes.test.tsx) because the bare
  // wrapper is exactly the kind of thing a mirror can quietly stop resembling.
  it("frames the public 404 like every other public page", async () => {
    const view = await renderAt("/this-route-does-not-exist");
    expect(view.container.textContent).toContain("This page could not be found.");
    expect(within(view.container).getByLabelText("AskDocs home")).toBeTruthy();
    expect(
      within(view.container).getByRole("navigation", { name: "Legal" }),
    ).toBeTruthy();
    // Still exactly one main: the shell supplies it, and a nested second one
    // would be the overcorrection (#460).
    expect(view.container.querySelectorAll("main, [role='main']")).toHaveLength(1);
    view.unmount();
  });

  // The reason the chrome matters: from the 404 the marketing pages have to be
  // one click away, not just present on the page.
  it("links the public 404 to every page the navigation advertises", async () => {
    const view = await renderAt("/this-route-does-not-exist");
    const hrefs = [...view.container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    for (const section of [NAV_PRODUCT, NAV_COMPANY, NAV_LEGAL]) {
      for (const { label, to } of section) {
        expect(hrefs, `the 404 should link to ${to} (${label})`).toContain(to);
      }
    }
  });

  it("gives every public page exactly one main landmark", async () => {
    // Lighthouse's landmark-one-main audit fails on a page with no <main>, and
    // a screen-reader user has no jump target without one. /, /login and
    // /register had none; the marketing routes already render one via
    // PageLayout, and /demo via DemoPage.
    //
    // "Exactly one" is deliberate: a nested second <main> is a different
    // failure (landmark-unique), and this assertion catches it too rather than
    // letting a fix for the missing case introduce a duplicate.
    for (const route of [...MARKETING_ROUTES, "/login", "/register"]) {
      const view = await renderAt(route);
      expect(
        view.container.querySelectorAll("main, [role='main']").length,
        `route ${route} should expose exactly one main landmark`,
      ).toBe(1);
      view.unmount();
    }
  });

  it("keeps the navbar and footer outside the main landmark", async () => {
    // <main> must not wrap the banner or contentinfo landmarks: they are page
    // furniture, and burying them inside main is what makes a landmark list
    // unreadable. Asserted on the landing page, which has both.
    const view = await renderAt("/");
    const main = view.container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main?.querySelector("header.landing-navbar")).toBeNull();
    expect(main?.querySelector("footer")).toBeNull();
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

  it("does not name Groq as an embedding processor", async () => {
    // Groq has no embeddings API: `services/embedding.py` builds a single
    // OpenAI client and raises without OPENAI_API_KEY. A sub-processor list is a
    // disclosure of who receives personal data, so "OpenAI, Groq used for
    // embeddings" was a false statement, not a simplification.
    const view = await renderAt("/privacy");
    const text = view.container.textContent ?? "";

    const embeddingsSentence = text
      .split(/[.!?]\s+/)
      .find((sentence) => /embedding/i.test(sentence) && /openai|groq/i.test(sentence));
    expect(embeddingsSentence).toBeDefined();
    // The sentence that covers embeddings must attribute them to OpenAI alone.
    expect(embeddingsSentence).toMatch(/embedding[^.]*openai only/i);
    expect(embeddingsSentence).not.toMatch(/groq[^.]*embedding/i);
  });

  it("separates which provider does what instead of implying parity", async () => {
    // OpenAI and Groq are interchangeable for question answering only. The About
    // stack line listed them as one alternative, which reads as "either works
    // for everything the product does".
    const view = await renderAt("/about");
    const text = view.container.textContent ?? "";
    expect(text).toMatch(/Groq, OpenAI, or a local server/i);
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

describe("page hero layout", () => {
  /* jsdom does not cascade the real stylesheet, and a flex alignment is exactly
     the kind of property no render assertion can see — the DOM is identical
     whether the subtitle is centred or not. So the alignment is pinned at the
     stylesheet level, the same way LandingFooter.test.tsx does it, and the DOM
     check only covers what the stylesheet cannot: that a subtitle exists and
     that it is inside the container being centred. */
  const css = readFileSync(resolve(__dirname, "../App.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /** Declarations of the first rule whose selector list contains `selector`. */
  function declarationsFor(selector: string): string[] {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
      if (selectors.includes(selector)) {
        return (match[2] ?? "")
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean);
      }
    }
    throw new Error(`no rule found for selector "${selector}" in App.css`);
  }

  const valueOf = (decls: string[], prop: string): string | undefined =>
    decls
      .filter((d) => d.startsWith(`${prop}:`))
      .map((d) => d.slice(prop.length + 1).trim())[0];

  it("centres the hero children instead of relying on inherited text-align", () => {
    // `text-align: center` on `.page-hero` only centres a child that fills the
    // measure. The `h1` fills it and so looked centred, while the narrower
    // subtitle (560px in a 780px box, no auto side margins) rendered flush left.
    const decls = declarationsFor(".page-hero-inner");
    expect(valueOf(decls, "display")).toBe("flex");
    expect(valueOf(decls, "flex-direction")).toBe("column");
    expect(valueOf(decls, "align-items")).toBe("center");
  });

  it("keeps the page hero in step with the landing hero", () => {
    // PageLayout reuses the landing hero's classes verbatim so the two read as
    // one site. Diverging here is what let the subtitle drift out of centre.
    const landing = declarationsFor(".landing-hero-inner");
    const page = declarationsFor(".page-hero-inner");
    for (const prop of ["display", "flex-direction", "align-items"]) {
      expect(valueOf(page, prop), prop).toBe(valueOf(landing, prop));
    }
  });

  it("puts a subtitle inside the centred container on every page hero", async () => {
    // Two routes are expected to have no document hero, and each for a stated
    // reason: `/` carries the landing hero (`.landing-hero-inner`), which is the
    // reference rather than the subject, and `/demo` composes the navbar and
    // footer directly and opens with a `demo-banner` instead. Every other
    // marketing route goes through PageLayout.
    const withoutHero: string[] = [];

    for (const route of MARKETING_ROUTES.filter((r) => r !== "/")) {
      const view = await renderAt(route);
      const inner = view.container.querySelector(".page-hero-inner");

      if (!inner) {
        withoutHero.push(route);
        view.unmount();
        continue;
      }

      const subtitle = inner.querySelector(".landing-sub");
      // Every PageLayout page is expected to carry a subtitle; a page that
      // dropped it would render centred-but-empty and look intentional.
      expect(subtitle, `${route} hero subtitle`).not.toBeNull();
      expect(
        (subtitle?.textContent ?? "").trim().length,
        `${route} subtitle is not empty`,
      ).toBeGreaterThan(0);

      view.unmount();
    }

    // Pinning the list keeps this honest in both directions: a new PageLayout
    // page is covered automatically, and a new page that skips PageLayout has to
    // be declared here rather than slipping past the check.
    expect(withoutHero).toEqual(["/demo"]);
  });
});

describe("navigation coverage", () => {
  it("offers every page in each section, and Company's hub as one of them", async () => {
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
    // Company has no separate hub link, so "General" is the only way into
    // /company from here (#584). A `hub: "/company"` left set alongside it would
    // render the same destination twice in one column.
    expect(
      footerCompany.queryByRole("link", { name: "Overview" }),
      "the footer's Company column still has its own Overview link",
    ).toBeNull();
    for (const item of NAV_COMPANY) {
      expect(
        footerCompany.getByRole("link", { name: item.label }).getAttribute("href"),
      ).toBe(item.to);
    }
    // One entry per destination, so "General" and a leftover hub cannot both
    // point at /company and read as two different pages.
    // `within()` hands back queries, not the element, so this is not
    // querySelectorAll.
    const hrefs = footerCompany
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(new Set(hrefs).size, `duplicate footer link in ${hrefs.join(" ")}`).toBe(
      hrefs.length,
    );

    const footerLegal = within(screen.getByRole("navigation", { name: "Legal" }));
    for (const item of NAV_LEGAL) {
      expect(
        footerLegal.getByRole("link", { name: item.label }).getAttribute("href"),
      ).toBe(item.to);
    }
  });
});
