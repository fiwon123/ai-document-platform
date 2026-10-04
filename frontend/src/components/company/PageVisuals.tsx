/**
 * The five marketing-page visuals (`/company`, `/about`, `/blog`, `/careers`,
 * `/contact`).
 *
 * ## Why these exist
 *
 * Every one of those pages put its prose in a 52ch column inside a 1200px body
 * and left the rest of the row empty — at 1440px that is roughly 40% of the
 * width with nothing in it (#585). The fix the issue asks for is not to stretch
 * the text: "prose keeps a ~65–75 character measure; widening happens by adding
 * a second column". So each page now pairs its prose with one of these.
 *
 * ## Why they are abstract
 *
 * These are diagrams and motifs, not illustrations of people. Two reasons. The
 * codebase already draws its figures as boxes and paths (`ArchitectureDiagram`,
 * `StageIllustration`, `FlowIllustration`), so a cartoon would be the odd one
 * out. And a drawn figure asserts a claim: an illustration of "a team" makes a
 * promise about a team that a two-person open-source project has not made.
 * A diagram of the three things the page actually argues for asserts only what
 * the prose beside it already says.
 *
 * ## Colour and text
 *
 * Follows the rule #581 established: every tone is `currentColor` at a stated
 * opacity, a token, or a `[data-accent]` group, so dark theme needs no rule on
 * the SVG itself. **No text is faded with opacity** — a review measured
 * subtitles at 2.84–4.23:1 against their own fills when they were, so
 * hierarchy here is size and weight, as in the architecture diagram.
 *
 * All five are `aria-hidden`. Each one restates something already written in the
 * prose next to it, so the prose is the text equivalent — which is the test
 * #581's diagram failed and had to earn a `<ul>` over. The blog illustration is
 * the exception that proves the rule: it is the empty state's subject rather
 * than a restatement of anything, and it is still hidden because the heading and
 * the two sentences below it already carry the message.
 */

import type { ReactNode } from "react";

type Accent = "blue" | "violet" | "green" | "amber";

/**
 * The shared frame: a tinted panel that holds one drawing.
 *
 * `role="presentation"` rather than `aria-hidden` on the wrapper is deliberate
 * — `aria-hidden` on a focusable-or-landmark-looking box is a smell, and this
 * box is neither, so the SVG inside is what carries `aria-hidden`.
 */
function Figure({
  accent,
  label,
  children,
}: {
  accent: Accent;
  /** Short description of what the drawing shows, for the comment and tests. */
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="page-figure" data-accent={accent} data-figure={label}>
      <svg className="page-figure-svg" viewBox="0 0 360 240" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared primitives. Stroke weight and wash opacity are stated once.   */
/* ------------------------------------------------------------------ */

/**
 * The ruled lines of the blog sheet, as opacities over `--ink`.
 *
 * Not decoration values. These lines *stand for the text of a page*, so they are
 * held to the same 3:1 non-text floor `.page-figure path` states for strokes —
 * and a first version broke that rule silently, because it faded `<rect>`s with
 * inline `opacity` while the 3:1 rule only ever covered `<path>`. Measured on
 * the rendered pixels, the body rules came out at **1.38:1 light, 1.55:1 dark**
 * against the sheet: invisible as text, and weak enough beside the sheet's own
 * 12:1 border that the drawing looked half-erased rather than faint.
 *
 * Solved for rather than nudged. Compositing `--ink` at alpha over the sheet's
 * real fill (paper + the panel's corner wash — light `rgb(243,243,244)`, dark
 * `rgb(29,35,49)`) and solving for 3:1 gives alpha **0.50** in light and **0.40**
 * in dark; one value has to serve both themes, so it is 0.50. The faint sub-rules
 * that used to sit under each line are gone rather than lifted: there is no
 * opacity left under 3:1, so there was nothing to keep them at.
 */
const BODY = 0.5;
const TITLE = 0.62;

/** A wash panel, the same shape as an architecture-diagram box. */
function Panel({
  x,
  y,
  w,
  h,
  fill = 0.06,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: number;
}) {
  return <rect x={x} y={y} width={w} height={h} rx={10} fill="currentColor" opacity={fill} />;
}

function Outline({
  x,
  y,
  w,
  h,
  width = 1.6,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  width?: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
    />
  );
}

/** A caption inside a panel. Never faded — size and weight carry hierarchy. */
function Caption({
  x,
  y,
  children,
  anchor = "middle",
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text x={x} y={y} className="fig-label" textAnchor={anchor}>
      {children}
    </text>
  );
}

/**
 * A stroked line.
 *
 * `kind` is not decoration — it is what the geometry tests assert against, and
 * the two kinds have opposite rules. A **connector** routes *between* things
 * (the principles spine, the careers spine, a question→channel run) and must
 * not cross a box's interior, because #581 found a line drawn over a box reads
 * as a rendering bug. A **mark** stands *for* content inside a box (the ruled
 * lines of a card, the placeholder rule of a role row) and must be contained by
 * it. Marking them in the markup is what lets one test say both.
 */
function Link({
  d,
  width = 1.8,
  kind = "connect",
}: {
  d: string;
  width?: number;
  kind?: "connect" | "mark";
}) {
  return (
    <path
      d={d}
      className={kind === "connect" ? "fig-link" : "fig-mark"}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
    />
  );
}

/* ------------------------------------------------------------------ */
/* /company — the three things the page argues for                      */
/* ------------------------------------------------------------------ */

/**
 * The three principles as three anchored points: each a box on its own line,
 * each with a node on a shared spine that runs down the left margin.
 *
 * The spine matters. A connector that hopped from box to box would have to cross
 * into the third box, and #581 found that a line drawn over a box reads as a
 * rendering bug rather than as routing. So the spine sits in the margin instead
 * and every box is reached from it, which is why its endpoints are the *centres*
 * of the first and last nodes rather than the margins above and below them: a
 * spine that ran past all three would leave the first node unattached, which is
 * the floating stub #581 removed from the architecture diagram.
 */
export function CompanyVisual() {
  const rows = [
    { y: 16, label: "Grounding", sub: "before fluency" },
    { y: 92, label: "Isolation", sub: "in the data model" },
    { y: 168, label: "Async", sub: "off the request" },
  ];
  return (
    <Figure accent="blue" label="principles">
      <Link d="M 20 36 V 188" />
      {rows.map((r) => (
        <g key={r.label}>
          <circle cx="20" cy={r.y + 20} r="4.5" fill="currentColor" />
          <Panel x={44} y={r.y} w={286} h={40} fill={0.06} />
          <Outline x={44} y={r.y} w={286} h={40} />
          <Caption x={60} y={r.y + 25} anchor="start">
            {r.label}
          </Caption>
          <text x={316} y={r.y + 25} className="fig-sub" textAnchor="end">
            {r.sub}
          </text>
        </g>
      ))}
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* /about — four principles, as a balanced block                        */
/* ------------------------------------------------------------------ */

/**
 * Four quadrants, each identical.
 *
 * Not a diagram of anything: the page's Principles grid beside it says the same
 * four things in four sentences. This is the "pattern" the issue allows, and it
 * exists to give the row a shape rather than to carry an argument.
 *
 * **All four are identical, deliberately.** A first version shortened the lower
 * rule of the bottom-right panel — reading as a "and this one is different"
 * accent — and a visual review caught that it looked like a typo rather than a
 * choice, because nothing in the drawing marked it as intentional. A pattern
 * with an unmarked exception is a mistake waiting to be read as a mistake.
 */
export function AboutVisual() {
  return (
    <Figure accent="violet" label="principles-grid">
      {[0, 1].map((col) =>
        [0, 1].map((row) => {
          const x = 24 + col * 168;
          const y = 32 + row * 96;
          return (
            <g key={`${col}-${row}`}>
              <Panel x={x} y={y} w={144} h={72} fill={0.06} />
              <Outline x={x} y={y} w={144} h={72} />
              <Link d={`M ${x + 20} ${y + 30} h 46`} width={2.6} kind="mark" />
              <Link d={`M ${x + 20} ${y + 48} h 100`} width={1.6} kind="mark" />
            </g>
          );
        }),
      )}
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* /blog — the empty state                                              */
/* ------------------------------------------------------------------ */

/**
 * An empty page with a ruled margin: a stack of ruled lines that stops.
 *
 * This is the one illustration that must not imply content. The ruled lines are
 * the *absence* of posts, and the drawing stops three-quarters down rather than
 * filling the page — a full stack of lines would read as "these posts are
 * coming" and a reader would wait for them. No dates, no titles, no bylines,
 * because the project's rule on honest absent affordances is that the blog shows
 * an empty state rather than fabricated posts, and a drawing of a post is the
 * same fabrication with fewer pixels.
 *
 * The last rule is drawn at the *title's* length rather than the body's, and it
 * is the only mark below the stack. That is the whole point of the drawing, so
 * it is drawn as an absence: there is no trailing glyph, no "more" mark, nothing
 * to wait for. An earlier version closed it with a ringed dash in the bottom
 * corner, which read as a control — and overlapped the sheet's own edge.
 */
export function BlogVisual() {
  const lines = [0, 1, 2, 3, 4].map((i) => 24 + i * 30);
  return (
    <Figure accent="green" label="empty-state">
      {/* The sheet */}
      <Panel x={96} y={8} w={168} h={224} fill={0.05} />
      <Outline x={96} y={8} w={168} h={224} />
      {/* Folded corner, so it reads as a page rather than a panel. It starts on the
          sheet's top edge and ends on its right edge, and it runs *inside* the
          sheet — which is a mark, not a connector: it describes the panel it
          sits in rather than routing between panels. */}
      <Link d="M 240 8 v 24 h 24" kind="mark" />
      {lines.map((y, i) => (
        <rect
          key={y}
          x={120}
          y={y}
          width={i === 0 ? 56 : 120}
          height={6}
          rx={3}
          fill="currentColor"
          opacity={i === 0 ? TITLE : BODY}
        />
      ))}
      {/* The rules stop here, and this is the point of the drawing. Drawn at the
          *title's* length rather than the body's, so the stop is the only thing
          that says there is no more content — and it says it by stopping, not by
          announcing itself. */}
      <Link d="M 120 196 h 56" width={1.4} kind="mark" />
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* /careers — what the work is like                                     */
/* ------------------------------------------------------------------ */

/**
 * Three open roles under one banner, each row the same length.
 *
 * The three rows are identical on purpose: the page has three roles and the
 * drawing has three rows, so the picture cannot go stale when a role is filled
 * or added — there is nothing here that claims a count. The banner above them
 * is the shared part of the job, and the spine in the left margin is what says
 * the three rows hang off the one banner above them.
 */
export function CareersVisual() {
  const rows = [0, 1, 2].map((i) => 92 + i * 44);
  return (
    <Figure accent="amber" label="open-roles">
      <Panel x={40} y={16} w={280} h={40} fill={0.07} />
      <Outline x={40} y={16} w={280} h={40} width={1.8} />
      <Caption x={180} y={41}>
        one project
      </Caption>
      {/* The spine runs in the 32-unit gutter between the margin and the rows
          (x = 56, rows start at x = 72), so it can reach every row without
          crossing one. It starts on the banner's bottom edge and ends on the
          last row's centre, which is what keeps it attached at both ends — the
          first revision drew a stub per row starting in open space and stopping
          short of its box, which is the floating line #581 removed. */}
      <Link d="M 56 56 V 196" />
      {rows.map((y) => (
        <g key={y}>
          <Link d={`M 56 ${y + 16} H 72`} />
          <Panel x={72} y={y} w={216} h={32} fill={0.05} />
          <Outline x={72} y={y} w={216} h={32} />
          <Link d={`M 92 ${y + 16} h 76`} width={2.2} kind="mark" />
          {/* Filled, not a ring. A review read the hollow version as an unselected
              radio button — the one thing a role row must not look like, since
              nothing on this page is selectable. `/blog`'s drawing drops its ring
              for the same reason. */}
          <circle cx="268" cy={y + 16} r="4" fill="currentColor" />
        </g>
      ))}
    </Figure>
  );
}

/* ------------------------------------------------------------------ */
/* /contact — which channel for which question                         */
/* ------------------------------------------------------------------ */

/**
 * Four questions on the left, four channels on the right, each paired.
 *
 * This one carries the page's only real argument — that a bug goes to issues
 * and not to email — so the pairing is deliberate rather than decorative. The
 * connectors are drawn in the gutter between the two columns and never cross a
 * box, for the reason #581 gave: a line over a label reads as a bug.
 *
 * `aria-hidden` is still correct. Each channel is a link with its own name one
 * paragraph below, so the pairing is available to a screen-reader user as the
 * prose; the drawing is a second presentation of it, not the only one.
 */
export function ContactVisual() {
  const pairs = [
    { q: "a bug", to: "issues" },
    { q: "the code", to: "repository" },
    { q: "a flaw", to: "security" },
    { q: "anything", to: "email" },
  ];
  const top = 22;
  const step = 50;
  return (
    <Figure accent="violet" label="channel-routing">
      <Caption x={78} y={top - 6} anchor="middle">
        question
      </Caption>
      <Caption x={295} y={top - 6} anchor="middle">
        channel
      </Caption>
      {pairs.map((p, i) => {
        const y = top + i * step;
        const cy = y + 18;
        return (
          <g key={p.to}>
            <Panel x={24} y={y} w={108} h={36} fill={0.06} />
            <Outline x={24} y={y} w={108} h={36} />
            <Caption x={78} y={y + 23}>
              {p.q}
            </Caption>
            {/* The gutter is 132 → 252, and every connector is a single
                straight run between the two columns' facing edges. A dogleg
                here would buy nothing: there is no crossing to route around,
                since each question has its own row and its own channel. The
                ends sit *on* the edges rather than near them — a 4-unit gap
                made the first one read as a line that stopped short. */}
            <Link d={`M 132 ${cy} H 252`} />
            <Panel x={252} y={y} w={84} h={36} fill={0.08} />
            <Outline x={252} y={y} w={84} h={36} />
            <text x={294} y={y + 23} className="fig-sub" textAnchor="middle">
              {p.to}
            </text>
          </g>
        );
      })}
    </Figure>
  );
}
