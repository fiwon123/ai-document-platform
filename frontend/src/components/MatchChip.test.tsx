import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchChip } from "./MatchChip";

describe("MatchChip", () => {
  it("renders the rounded similarity percentage", () => {
    render(<MatchChip pct={82.4} />);
    expect(screen.getByText("82% match")).toBeTruthy();
  });

  it("clamps out-of-range percentages", () => {
    const { container } = render(<MatchChip pct={140} />);
    expect(screen.getByText("100% match")).toBeTruthy();
    expect((container.firstChild as HTMLElement).title).toBe(
      "Similarity: 100.0%",
    );
  });

  it("classes the tone by strength: strong, partial, weak", () => {
    const { rerender, container } = render(<MatchChip pct={80} />);
    expect(container.querySelector(".result-match-chip")?.className).toContain(
      "tone-strong",
    );
    rerender(<MatchChip pct={50} />);
    expect(container.querySelector(".result-match-chip")?.className).toContain(
      "tone-partial",
    );
    rerender(<MatchChip pct={20} />);
    expect(container.querySelector(".result-match-chip")?.className).toContain(
      "tone-weak",
    );
  });

  it("exposes the exact similarity in the tooltip", () => {
    render(<MatchChip pct={7.3} />);
    expect(screen.getByTitle("Similarity: 7.3%")).toBeTruthy();
  });
});