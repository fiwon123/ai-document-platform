import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LandingFooter } from "./LandingFooter";
import { SOCIAL_PATHS } from "../content/marketing";

vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));

function renderFooter() {
  return render(
    <MemoryRouter>
      <LandingFooter />
    </MemoryRouter>,
  );
}

/**
 * The footer social row used to read as three circles with an oval in the
 * middle, and the cause was not where it looked. These tests pin the two
 * properties that actually decide whether the glyph lines up with its circular
 * button: the viewBox must match the grid the path was authored on, and all
 * three glyphs must render at the same visual size.
 */

function svgFor(label: string) {
  const node =
    screen.getByLabelText(new RegExp(label)).querySelector("svg") ??
    screen.getByRole("img", { name: new RegExp(label) }).querySelector("svg");
  if (!node) throw new Error(`no svg rendered for ${label}`);
  return {
    viewBox: node.getAttribute("viewBox") ?? "",
    size: Number(node.getAttribute("width")),
  };
}

describe("LandingFooter social icons", () => {
  it("renders all three glyphs at the same 18px display size", () => {
    renderFooter();
    for (const label of ["GitHub", "Twitter", "LinkedIn"]) {
      expect(svgFor(label).size, label).toBe(18);
    }
  });

  it("gives GitHub a 16x16 viewBox to match its 16x16 Octicons path", () => {
    renderFooter();
    // The other two paths are authored on a 24x24 grid. If GitHub shared that
    // viewBox its disc would render at 16/24 of 18px and look undersized.
    expect(svgFor("GitHub").viewBox).toBe("0 0 16 16");
    expect(svgFor("Twitter").viewBox).toBe("0 0 24 24");
    expect(svgFor("LinkedIn").viewBox).toBe("0 0 24 24");
  });

  it("uses the circular disc mark for GitHub, not the egg-shaped Octocat", () => {
    // The glyph used to be the Octocat *silhouette*: a solid blob whose outline
    // is an egg. Its bounding box was almost square (~0.975 w:h) — effectively
    // the same as the disc's — so aspect ratio was never the tell, and no
    // viewBox can fix a silhouette's shape. What changed the read is the outer
    // boundary, so that is what this pins.
    //
    // A disc is built as an explicit circle: move to the top, curve to the left
    // edge, close back with a radius-8 arc spanning the full 16-unit width.
    const d = SOCIAL_PATHS.github;
    expect(d).toMatch(/^M8 0C3\.58 0 0 3\.58 0 8/);
    expect(d).toMatch(/A8\.013 8\.013 0 0 0 16 8c0-4\.42-3\.58-8-8-8Z$/);
  });

  it("authors each glyph on the grid its viewBox declares", () => {
    // A glyph authored on a different grid than its viewBox is rendered
    // scaled-down and wrong-looking, with no error anywhere. These two are the
    // only two grids in use, so pin the pairing for each.
    expect(SOCIAL_PATHS.github).toMatch(/^M8 0/);      // 16x16
    expect(SOCIAL_PATHS.twitter).toMatch(/^M23\.95/);  // 24x24
    expect(SOCIAL_PATHS.linkedin).toMatch(/^M20\.45/); // 24x24
  });

  it("keeps the round button geometry on every social icon", () => {
    renderFooter();
    // The container is what the glyph has to sit inside. All three share it, so
    // it must stay square with a fully rounded border — an oval button would
    // make every glyph look wrong at once.
    for (const label of ["GitHub", "Twitter", "LinkedIn"]) {
      const el =
        screen.getByLabelText(new RegExp(label)) ??
        screen.getByRole("img", { name: new RegExp(label) });
      expect(el.className, label).toContain("footer-social");
    }
  });
});

/**
 * Two stylesheet-level guards follow, one per defect that a render assertion
 * cannot see: the social button's box (#401) and the subscribe row's alignment
 * (#402). jsdom does not cascade the real stylesheet, and both failure modes
 * are structural — a rule outranking another, a flex alignment — so these read
 * App.css from disk, the same approach themeTokens.test.ts uses (and the reason
 * tsconfig.app.json includes the "node" types). The DOM assertions above pass
 * happily against a broken stylesheet.
 *
 * Read from disk rather than Vite's `?raw`: CSS imports are stubbed under this
 * vitest config, so `?raw` resolves to an empty string.
 */
const css = readFileSync(resolve(process.cwd(), "src", "App.css"), "utf8").replace(
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

/** Declarations from *every* rule carrying `selector`. `.newsletter` appears in
 *  the base rule and again in the <=820px media query, and a `center` in either
 *  one re-creates the float, so both have to be seen. */
function allDeclarationsFor(selector: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) {
      found.push(
        ...(match[2] ?? "")
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean),
      );
    }
  }
  if (found.length === 0) {
    throw new Error(`no rule found for selector "${selector}" in App.css`);
  }
  return found;
}

/** All values declared for `prop` — a rule may set it more than once across
 *  breakpoints, so this stays a list. */
const valuesOf = (decls: string[], prop: string): string[] =>
  decls
    .filter((d) => d.startsWith(`${prop}:`))
    .map((d) => d.slice(prop.length + 1).trim());

/** First value declared for `prop`, for properties that are not breakpoint-
 *  dependent. */
const valueOf = (decls: string[], prop: string): string | undefined =>
  valuesOf(decls, prop)[0];

describe("LandingFooter social button box", () => {
  it("gives .footer-social an explicitly square box and a fully rounded border", () => {
    const decls = declarationsFor(".footer-social");
    const width = valueOf(decls, "width");
    const height = valueOf(decls, "height");

    // A circle needs a square box. These two are load-bearing, not incidental:
    // if either goes missing the border-radius has nothing to stay circular
    // inside. Equal-by-value, so the test fails on 34px vs 35px too.
    expect(width, "width must be declared").toBeDefined();
    expect(height, "height must be declared").toBeDefined();
    expect(width, "width and height must match for a circle").toBe(height);
    expect(valueOf(decls, "border-radius")).toBe("50%");
  });

  it("stops footer-column link rules from reaching the social buttons", () => {
    // The regression, stated as an invariant rather than as a cascade
    // simulation: any rule that sets `width` on a link inside a footer column
    // must be scoped to `nav`, so it cannot leak into the brand column where
    // the social buttons live.
    //
    // `.footer-col a` (0,1,1) matched the brand column's social links and
    // declared `width: fit-content`, outranking `.footer-social` (0,1,0) and its
    // `width: 34px`. `height: 34px` was uncontested, so the button resolved to
    // 20x36px and `border-radius: 50%` drew an ellipse. Twitter and LinkedIn
    // were immune only because they are `<span>` placeholders and the rule
    // matches `a`.
    const offenders: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? "";
      if (!/(^|;)\s*width\s*:/.test(body)) continue;

      for (const selector of (match[1] ?? "").split(",").map((s) => s.trim())) {
        const targetsColumnLink = /\.footer-col\b/.test(selector) && /(^|\s)a(\s|$|:|\[|\.)/.test(selector);
        // "Scoped to nav" covers both `nav` as its own compound and `nav` as the
        // qualifier on the column's own class: `nav.footer-col a` is the stricter
        // of the two, since the brand column is a `<div>`. Requiring a standalone
        // `nav` token would have rejected it while letting the descendant form —
        // which matches nothing at all — look safe.
        const scopedToNav = /(^|[\s>+~])nav\b/.test(selector);
        if (targetsColumnLink && !scopedToNav) {
          offenders.push(selector);
        }
      }
    }
    // `.footer-col a { width: fit-content }` reintroduced here fails this.
    expect(offenders).toEqual([]);
  });

  it("scopes the rule to a nav that is itself the column, not a nav inside one", () => {
    // The mirror image of the bug above, and the one that bit #442. Narrowing the
    // rule to `.footer-col nav a` looked like the fix for the social-button leak
    // because it contains the word `nav` — but the column IS the `<nav>`, so that
    // selector matches nothing at all. The 14 column links silently fell back to
    // unstyled browser-default blue underlined anchors.
    //
    // So the escape has to be `nav.footer-col a`: a `nav` compound carrying the
    // class, which cannot match the brand column because that one is a `<div>`.
    // Both forms are safe, and either alone would pass the check above — assert
    // the one that actually matches the markup.
    expect(css).toMatch(/nav\.footer-col\s+a\s*\{/);
    expect(css).not.toMatch(/\.footer-col\s+nav\s+a\s*\{/);
  });

  it("keeps the column links inside a real <nav> the rule can match", () => {
    // `nav.footer-col a` depends on the markup as much as the stylesheet: change
    // `<nav className="footer-col">` to a `<div>` and the rule stops matching,
    // which is the same silent no-op as the selector above — the brand column
    // really is a `<div>`, so nothing else would notice.
    renderFooter();
    const columns = document.querySelectorAll(".footer-cols > .footer-col");
    expect(columns.length).toBeGreaterThan(1);
    const navs = document.querySelectorAll(".footer-cols > nav.footer-col");
    // Every column except the brand one is a <nav>; the brand column holds the
    // social buttons and the newsletter form, and must stay out of the rule.
    expect(navs.length).toBe(columns.length - 1);
    expect(document.querySelector(".footer-brand")?.tagName).toBe("DIV");
  });

  it("keeps .footer-social self-sufficient about being a link", () => {
    // GitHub renders as a real <a href>; Twitter and LinkedIn are spans. If the
    // underline suppression is left to a distant `.footer-col a` rule, the
    // button depends on a selector that outranks it and only reaches it by
    // accident — exactly the coupling that caused this bug.
    const decls = declarationsFor(".footer-social");
    expect(valueOf(decls, "text-decoration")).toBe("none");
  });
});

describe("LandingFooter subscribe form", () => {
  it("sits inside the brand column instead of spanning the footer", () => {
    // As a sibling of the columns the signup got a hairline and a full-width row
    // to itself, which framed an optional form as the footer's headline. It now
    // fills the empty space under the social icons in the widest column (2fr),
    // which the nav columns next to it had left blank.
    renderFooter();
    const footer = document.querySelector(".landing-footer");
    const newsletter = document.querySelector(".newsletter");

    expect(newsletter, "newsletter form").not.toBeNull();
    expect(newsletter?.parentElement, "newsletter's parent").toBe(
      document.querySelector(".footer-brand"),
    );
    // Still genuinely a child of the footer, just one level deeper — catches a
    // future edit that detaches it without moving it anywhere useful.
    expect(footer?.contains(newsletter as Node)).toBe(true);
  });

  it("comes after the social icons, so the links read before the invitation", () => {
    renderFooter();
    const brand = document.querySelector(".footer-brand");
    const socials = brand?.querySelector(".footer-socials");
    const newsletter = brand?.querySelector(".newsletter");

    expect(socials, "social icons").not.toBeNull();
    expect(newsletter, "newsletter form").not.toBeNull();
    // compareDocumentPosition rather than an index into children: it asserts
    // document order without depending on which sibling tags sit between them.
    // The `&&` chain narrows both to non-null, which the bitwise `&` requires.
    const follows = Boolean(
      socials &&
        newsletter &&
        (socials.compareDocumentPosition(newsletter) &
          Node.DOCUMENT_POSITION_FOLLOWING),
    );
    expect(follows, "newsletter follows the social icons").toBe(true);
  });

  it("leaves only the columns and the copyright row as the footer's children", () => {
    renderFooter();
    const order = Array.from(
      document.querySelectorAll(".landing-footer > *"),
    ).map((el) => el.className);

    // The form is no longer a top-level block, so it must not appear here. An
    // extra sibling would be a new band across the footer — the thing this
    // change removed.
    expect(order).toEqual(["footer-cols", "footer-bottom"]);
  });

  it("stacks heading, promise, and form down the column", () => {
    // Each part is a step, so the column reads top to bottom rather than the
    // form sitting beside the copy as a wide two-column band did.
    expect(valuesOf(declarationsFor(".newsletter"), "flex-direction")).toEqual([
      "column",
    ]);
  });

  it("stays stacked at every breakpoint", () => {
    const directions = valuesOf(allDeclarationsFor(".newsletter"), "flex-direction");
    // Length matters as much as content: an absent declaration would fall
    // through to `row` and undo the layout at the default breakpoint.
    expect(directions.length).toBeGreaterThan(0);
    expect(directions.every((d) => d === "column")).toBe(true);
  });

  it("has no separator edge now that it is a block inside a column", () => {
    // The hairline only made sense while the form was a band of its own. Left
    // in place it would draw a rule across the middle of the brand column.
    const decls = declarationsFor(".newsletter");
    expect(valuesOf(decls, "border-top")).toEqual([]);
    expect(valuesOf(decls, "border-bottom")).toEqual([]);
  });

  it("grows the email field into the column instead of a fixed width", () => {
    // `min-width: 0` is the part that matters: a flex item's automatic minimum
    // size is its content width, so an input without it refuses to shrink below
    // the default `size` and can push the button past the column edge.
    const decls = declarationsFor(".newsletter-form input");
    expect(valueOf(decls, "flex")).toBe("1");
    expect(valueOf(decls, "min-width")).toBe("0");
    expect(valuesOf(decls, "width")).toEqual([]);
  });

  it("keeps the input and button in one flex row so their heights can match", () => {
    renderFooter();
    // The input and the button are already the same height — the input is
    // intrinsically 42.88px, and the button (40.88px, `border: none`) stretches
    // to match under `.newsletter-form`'s default `align-items: stretch`. That
    // is load-bearing, not incidental: pull the button out of the row and the
    // two controls are 2px apart with nothing left to equalise them. It is the
    // reason the form row survives a change that stacked everything else.
    const form = document.querySelector(".newsletter-form");
    expect(form, "newsletter form row").not.toBeNull();
    expect(form?.querySelector("input"), "input inside the row").not.toBeNull();
    expect(form?.querySelector("button"), "button inside the row").not.toBeNull();
  });

  it("keeps the row above the stacking breakpoint and scopes the stack to phones", () => {
    // The base rule carries the single-row form: no `flex-direction` means
    // `row`, which is what lines the input up with the button so their heights
    // match (the 2px intrinsic difference is absorbed by the row's stretch).
    // "Never a breakpoint override" used to be the whole invariant, because
    // base-vs-breakpoint disagreement on the same property was how the two
    // controls lost their shared line. It is now "the override exists, it is
    // scoped to the narrow phones that need it, and it leaves the base rule
    // alone": below ~410px the row cannot hold the placeholder at all — at
    // 375px the input is squeezed to a 113px content box and `you@company.com`
    // renders as `you@company.c` (#573, found in the 2026-09-30 audit).
    const base = declarationsFor(".newsletter-form");
    expect(
      valuesOf(base, "flex-direction"),
      "base form must not declare a direction — row is the default it needs",
    ).toEqual([]);
    expect(valuesOf(base, "width"), "base form width").toEqual(["80%"]);

    const narrow = css.match(
      /@media[^{]*max-width:\s*430px[^{]*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(narrow, "no @media (max-width: 430px) block in App.css").toBeDefined();
    const formRule = narrow!.match(/\.newsletter-form\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(formRule, "the narrow form must stack: a row cannot fit the placeholder").toMatch(
      /flex-direction\s*:\s*column/,
    );
    expect(formRule, "the stacked form must take the whole column, not 80%").toMatch(
      /width\s*:\s*100%/,
    );

    // And the stack must not leak above the breakpoint: the base rule declares
    // the width exactly once and no direction, which is all the row needs.
    const widths = valuesOf(base, "width");
    expect(widths.length, "one width declaration, not a base/breakpoint saga").toBe(1);
  });
});

/**
 * The submit path.
 *
 * This is the only thing in the footer a visitor can actually do, and it used to
 * have no test at all: the handler cleared the field and said nothing, so a
 * subscription looked identical to a form that was broken. The handler now
 * reports what happened through a live region, and — because no mailing list is
 * connected — it refuses to claim the address was stored.
 */
describe("LandingFooter newsletter submit", () => {
  const status = () => document.querySelector(".newsletter-status");
  const emailInput = () =>
    document.querySelector<HTMLInputElement>('input[name="email"]');

  /** Submit the form the way a click does, through RTL so React's own handler
   *  runs. jsdom does not apply interactive validation to a dispatched submit,
   *  so the branch is decided by the handler's `checkValidity()` — which is the
   *  behaviour under test anyway. */
  function submit(address: string) {
    const input = emailInput();
    if (!input) throw new Error("no newsletter email input");
    const form = document.querySelector(".newsletter");
    if (!form) throw new Error("no newsletter form");
    input.value = address;
    fireEvent.submit(form);
  }

  it("has the live region in the DOM before anything is submitted", () => {
    // The ordering is the whole point: a region inserted at the same moment as
    // its text can go unannounced, so it must already be sitting there, empty.
    renderFooter();
    expect(status(), "status region").not.toBeNull();
    expect(status()?.getAttribute("role")).toBe("status");
    expect(status()?.getAttribute("aria-live")).toBe("polite");
    expect(status()?.textContent, "empty at rest").toBe("");
  });

  it("reports the outcome and clears the field when the address looks valid", () => {
    renderFooter();
    submit("reader@example.com");

    expect(status()?.textContent).toBe(
      "Thanks for trying — no mailing list is connected yet, so this didn't sign you up.",
    );
    expect(status()?.getAttribute("data-kind")).toBe("ok");
    expect(emailInput()?.value, "field cleared").toBe("");
  });

  it("never claims the address was stored, in the copy or the confirmation", () => {
    // A stub form that says "you're subscribed!" is the defect being fixed, so
    // the two strings most able to over-promise are pinned exactly: rewording
    // either one is a deliberate edit, not an accident.
    renderFooter();
    const copy = document.querySelector(".newsletter-copy")?.textContent ?? "";

    expect(copy, "no promise of a monthly email").not.toMatch(/once a month/i);
    expect(copy, "and it admits the list is not connected").toMatch(
      /no mailing list is connected/i,
    );

    submit("reader@example.com");
    const said = status()?.textContent ?? "";
    expect(said, "no claim of a subscription").not.toMatch(
      /subscrib(ed|ing)|you're in|thank you for subscribing/i,
    );
    // "Thanks" is fine — the sentence that follows is what makes it honest.
    expect(said).toMatch(/no mailing list is connected yet/i);
  });

  it("keeps the typed address and explains the problem when it is not valid", () => {
    renderFooter();
    submit("not-an-address");

    expect(status()?.textContent).toBe("Enter a valid email address.");
    expect(status()?.getAttribute("data-kind")).toBe("error");
    // Destroying the address on a failed submit is the same data loss as the
    // silent clear, just with a worse excuse.
    expect(emailInput()?.value, "address preserved").toBe("not-an-address");
  });

  it("marks the field invalid for assistive technology on a failed submit", () => {
    renderFooter();
    expect(emailInput()?.getAttribute("aria-invalid"), "at rest").toBe("false");

    submit("not-an-address");
    expect(emailInput()?.getAttribute("aria-invalid")).toBe("true");

    // And it clears again on a good one, so a stale "invalid" cannot outlive
    // the error that set it.
    submit("reader@example.com");
    expect(emailInput()?.getAttribute("aria-invalid")).toBe("false");
  });

  it("returns focus to the field when the submit was rejected", () => {
    renderFooter();
    submit("not-an-address");
    // The message is announced, but a mouse user has no other route back to the
    // field they have to correct.
    expect(document.activeElement).toBe(emailInput());
  });

  it("replaces the message on a second submit instead of stacking them", () => {
    renderFooter();
    submit("not-an-address");
    submit("reader@example.com");

    const regions = document.querySelectorAll(".newsletter-status");
    expect(regions.length, "one region, not a log").toBe(1);
    expect(status()?.textContent).not.toMatch(/Enter a valid email address/);
  });

  it("gives the status line an error colour that clears AA on the footer", () => {
    // --danger is a border/fill token and measured 4.41:1 (light) and 3.14:1
    // (dark) as small text on the footer's --surface, so the status text uses a
    // dedicated --danger-text instead, the same way --green-text exists for
    // --green. The ratios are recomputed here so a later theme change cannot
    // quietly drop the text below the 4.5:1 it is pinned at.
    const tokens = (theme: "light" | "dark") => {
      const block =
        theme === "dark"
          ? css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ""
          : (css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "");
      const read = (name: string) =>
        block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1] ?? "";
      return { dangerText: read("--danger-text"), surface: read("--surface") };
    };

    const luminance = (hex: string) => {
      const h = hex.replace("#", "");
      // Indexed access, not destructuring: `noUncheckedIndexedAccess` makes every
      // element of `[0, 2, 4].map(...)` a `number | undefined`, which fails
      // `tsc -b` while vitest happily runs it.
      const at = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
      const channel = (c: number) =>
        c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      return (
        0.2126 * channel(at(0)) + 0.7152 * channel(at(2)) + 0.0722 * channel(at(4))
      );
    };
    const ratio = (a: string, b: string) => {
      const hi = Math.max(luminance(a), luminance(b));
      const lo = Math.min(luminance(a), luminance(b));
      return (hi + 0.05) / (lo + 0.05);
    };

    for (const theme of ["light", "dark"] as const) {
      const { dangerText, surface } = tokens(theme);
      expect(dangerText, `${theme} --danger-text`).not.toBe("");
      expect(ratio(dangerText, surface), `${theme} error text`).toBeGreaterThanOrEqual(
        4.5,
      );
    }

    // And the rule actually reaches for the text token, not the fill one.
    expect(valueOf(declarationsFor('.newsletter-status[data-kind="error"]'), "color")).toBe(
      "var(--danger-text)",
    );
  });

  it("keeps the status line from re-creating the 320px min-content overflow", () => {
    // The column is `align-items: flex-start`, so a flex item's min-content
    // floor applies to this <p> exactly as it did to the form row that used to
    // push the page 26px wide at 320-414px. `overflow-wrap: break-word` is what
    // stops a long unbroken message from setting that floor — assert the value,
    // not the property's presence, because `normal` also declares it and wraps
    // nothing.
    expect(
      valueOf(declarationsFor(".newsletter-status"), "overflow-wrap"),
    ).toBe("break-word");
  });

  it("reserves no space for the status line while there is nothing to say", () => {
    // The region must stay rendered (that is what makes it announceable), so
    // the resting gap has to come from the margin instead. `margin-top: 8px` on
    // the base rule would leave a permanent 8px hole under every footer on the
    // site; the `:not(:empty)` rule is what makes the margin conditional.
    expect(
      valueOf(declarationsFor(".newsletter-status"), "margin"),
      "base margin is zeroed",
    ).toBe("0");
    expect(
      valueOf(declarationsFor(".newsletter-status:not(:empty)"), "margin-top"),
      "gap appears only when there is a message",
    ).toBe("8px");
  });

  it("stops claiming the field is invalid once it is", () => {
    // `aria-invalid` outliving its reason is a lie the DOM keeps telling: the
    // address is valid but the attribute still says otherwise, and it did so
    // until the next submit. The ARIA authoring practices ask for a re-evaluation
    // on change, and the message has to go with the attribute — it is not true
    // either. Guessing the moment of correction is impossible; a validity check
    // per keystroke is the only honest way to know.
    renderFooter();
    const input = screen.getByLabelText(/email address/i) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "not-an-address" } });
    fireEvent.submit(input.closest("form")!);
    expect(input).toHaveAttribute("aria-invalid", "true");

    // Adding a domain makes it a syntactically valid address, and it has to be
    // a real `local@domain` to cross it: "not-an-address.com" still has no `@`
    // and stays invalid.
    //
    // The values here were picked to be ones every environment classifies the
    // same way, because this suite's whole safety argument is that the handler
    // delegates to `checkValidity()` instead of reimplementing the email rules.
    // I expected jsdom to be the looser of the two and had to check: probing 12
    // values through `type="email"` in both jsdom and Chrome gives identical
    // verdicts, down to the odd corners ("a@b" and "a@@b.com"). So the agreement
    // comes from delegating -- a hand-rolled regex here would be free to drift
    // from the browser's, and these tests could not catch it.
    fireEvent.change(input, { target: { value: "not-an-address@example.com" } });
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(document.querySelector(".newsletter-status")).toHaveTextContent("");

    // ...and a half-typed address is not, so the claim must survive.
    fireEvent.change(input, { target: { value: "not-an" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "not-an-" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector(".newsletter-status")).toHaveTextContent(
      "Enter a valid email address.",
    );
  });

  it("keeps the error branch reachable in a real browser", () => {
    // Found by measuring, not by a failing test. With `type="email"` and no
    // `noValidate`, the browser blocks the submit event on a malformed address,
    // so the handler never runs: the field keeps its value, the status keeps
    // saying whatever it last said, and no message is ever shown. Every test
    // above still passes under that mutation, because jsdom fires `submit`
    // directly and skips interactive validation — so this is the only place the
    // reachability is pinned. The consequence of removing it is a dead message
    // and a permanently-false `aria-invalid`, not a visible test failure.
    renderFooter();
    expect(
      document.querySelector(".newsletter")?.hasAttribute("novalidate"),
      "the form must own its validation",
    ).toBe(true);
  });

  it("never takes the live region out of the render tree", () => {
    // `display: none` while empty is the tempting way to reclaim the 8px, and it
    // is the one version that can leave the confirmation unannounced: a region
    // that is hidden and revealed in the same tick as its text is the classic
    // silent-live-region bug, and jsdom cannot catch it because it resolves no
    // display from CSS. The margin is the safe way to reclaim the space, so no
    // rule may hide the element.
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) =>
        (m[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .some((s) => s.startsWith(".newsletter-status")),
      )
      .filter((m) => /display\s*:\s*none/.test(m[2] ?? ""))
      .map((m) => (m[1] ?? "").trim());

    expect(hiding, "rules hiding the status region").toEqual([]);
  });
});
