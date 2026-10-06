import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PIPELINE_STAGES } from "../../content/marketing";
import { PipelineTrack } from "./PipelineTrack";
import { StageIllustration } from "./StageIllustration";

/**
 * The pipeline as a *connected sequence* (#582).
 *
 * The assertions here are mostly about what is decorative and what is real.
 * That distinction is the whole risk of this component: it is a visual
 * explanation (rail, nodes, six illustrations) and every one of those pieces is
 * `aria-hidden`, so nothing here may be the *only* carrier of a fact. If a
 * stage title or an outcome were dropped and only the illustration survived, the
 * page would look fine and say nothing — which is why each one is asserted as
 * text rather than inferred from the SVG.
 */

describe("PipelineTrack", () => {
  it("renders every stage as a direct item of one ordered list", () => {
    const { container } = render(<PipelineTrack />);
    const lists = container.querySelectorAll("ol");
    expect(lists).toHaveLength(1);

    // Scoped to DIRECT children on purpose. Each stage also contains a
    // `.pipeline-facts` list, so a document-wide `listitem` query returns the
    // stages plus their fact chips (24, not 6) and would hide a wrapper that
    // inserted an extra <li> into the sequence.
    const stages = container.querySelectorAll("ol.pipeline > li.pipeline-stage");
    expect(stages).toHaveLength(PIPELINE_STAGES.length);
  });

  it("names every stage, with its ordinal left to the list semantics", () => {
    render(<PipelineTrack />);
    for (const stage of PIPELINE_STAGES) {
      // The stored title carries "1. " for the marketing copy elsewhere; the
      // card shows the bare name because the list conveys the order.
      expect(
        screen.getByRole("heading", { name: stage.title.replace(/^\d+\.\s*/, "") }),
      ).toBeInTheDocument();
    }
    // The ordinal is decoration and must not be announced twice.
    expect(screen.getByText("1", { selector: ".pipeline-stage-number" })).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("gives each stage an outcome, which is not the same as its detail", () => {
    render(<PipelineTrack />);
    const outcomes = document.querySelectorAll(".pipeline-outcome");
    expect(outcomes).toHaveLength(PIPELINE_STAGES.length);

    for (const stage of PIPELINE_STAGES) {
      // The acceptance criterion is that a stage says what the *user* gets. A
      // summary that merely restates the mechanism would satisfy a count but
      // not the point, so each outcome must be its own sentence rather than a
      // copy of the detail text.
      const outcome = document.querySelector(`.pipeline-outcome`)?.textContent;
      expect(outcome).toContain("You get");
      expect(stage.outcome.length).toBeGreaterThan(20);
    }
  });

  it("states the failure path, and says what a failed document does next", () => {
    render(<PipelineTrack />);
    const panel = screen.getByRole("note");
    expect(panel).toHaveClass("pipeline-failure");

    // On the accent scale rather than a hard-coded hue, so it is correct in dark
    // theme and cannot be mistaken for a stage that has not loaded.
    expect(panel).toHaveAttribute("data-accent", "rose");
    expect(panel).toHaveTextContent(/if extraction fails/i);
    // Honest about the outcome, not just the cause: the document is marked
    // failed, the reason is kept, and the rest of the workspace keeps working.
    expect(panel).toHaveTextContent(/failed/i);
    expect(panel).toHaveTextContent(/search and q&a keep serving/i);
  });

  it("marks only stage 2 as the stage that can fail", () => {
    render(<PipelineTrack />);
    const branches = document.querySelectorAll('.pipeline-stage[data-branch="failure"]');
    expect(branches).toHaveLength(1);
    // It is stage 2, the only stage that can fail a document.
    expect(branches[0]).toHaveTextContent(/extract/i);
  });

  it("hides the rail, the nodes and the illustrations from assistive tech", () => {
    const { container } = render(<PipelineTrack />);
    // Purely visual: the sequence is already carried by the list, and each
    // illustration restates a caption that is on the card in words.
    expect(container.querySelector(".pipeline-rail")).toHaveAttribute("aria-hidden", "true");
    for (const node of container.querySelectorAll(".pipeline-node")) {
      expect(node).toHaveAttribute("aria-hidden", "true");
    }
    for (const svg of container.querySelectorAll(".stage-illustration svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
    }
  });

  it("carries the scroll-progress variable the rail animates with", () => {
    const { container } = render(<PipelineTrack />);
    const track = container.querySelector(".pipeline-track") as HTMLElement;
    // jsdom + the hook's default of 1: the rail must render FULLY drawn when it
    // cannot animate, which is the static-frame-correctness requirement.
    expect(track.style.getPropertyValue("--track-progress")).toBe("1");
  });

  it("keeps each stage's accent, so the rail nodes match their card", () => {
    const { container } = render(<PipelineTrack />);
    const stages = container.querySelectorAll(".pipeline-stage");
    expect(stages).toHaveLength(PIPELINE_STAGES.length);
    PIPELINE_STAGES.forEach((stage, index) => {
      expect(stages[index]).toHaveAttribute("data-accent", stage.accent);
    });
  });
});

describe("StageIllustration", () => {
  const keys = ["upload", "extract", "chunk", "embed", "search", "ask"] as const;

  it("draws every stage's own scene rather than one repeated glyph", () => {
    const seen = new Set<string>();
    for (const stage of keys) {
      const { container } = render(<StageIllustration stage={stage} accent="blue" />);
      const markup = container.innerHTML;
      seen.add(markup);
      // A viewBox on every scene, so a malformed path cannot silently collapse
      // the illustration to nothing and still "render".
      expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 64 64");
    }
    // The old pipeline used a single 24×24 FeatureIcon per stage; six distinct
    // scenes is the point of #582, and this fails if they collapse to one.
    expect(seen.size).toBe(keys.length);
  });

  it("themes from the accent system instead of a literal colour", () => {
    for (const stage of keys) {
      const { container, unmount } = render(<StageIllustration stage={stage} accent="violet" />);
      const wrap = container.querySelector(".stage-illustration") as HTMLElement;
      expect(wrap).toHaveAttribute("data-accent", "violet");
      // No hard-coded hex anywhere: every tone is `currentColor`, resolved from
      // --card-accent, so the dark-theme restatement applies with no rule here.
      expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
      expect(container.innerHTML).toContain("currentColor");
      unmount();
    }
  });

  it("is decorative, so it never becomes the only carrier of a fact", () => {
    const { container } = render(<StageIllustration stage="upload" accent="blue" />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });
});

describe("stage content", () => {
  it("gives every stage an outcome sentence in the content module", () => {
    // Guarded here as well as in the component: the content module is the single
    // source for marketing copy, and an outcome missing from it would render an
    // empty "You get" chip.
    for (const stage of PIPELINE_STAGES) {
      expect(stage.outcome, `${stage.title} has no outcome`).toBeTruthy();
      expect(stage.outcome.trim().endsWith(".")).toBe(true);
    }
  });

  it("keeps the stage titles numbered for the copy that uses them verbatim", () => {
    // The landing page and the page subtitle reference the stages as prose, so
    // the stored titles keep their ordinals even though the card strips them.
    expect(PIPELINE_STAGES.map((s) => s.title)).toEqual([
      "1. Upload",
      "2. Extract",
      "3. Chunk",
      "4. Embed",
      "5. Search",
      "6. Ask",
    ]);
  });
});
