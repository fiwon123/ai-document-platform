import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedText } from "./HighlightedText";
import { highlightParts } from "../utils/highlight";

describe("highlightParts", () => {
  it("returns a single plain part for an empty query", () => {
    expect(highlightParts("two turntables", "")).toEqual([
      { text: "two turntables", highlight: false },
    ]);
  });

  it("highlights matches case-insensitively", () => {
    expect(highlightParts("Q3 planning notes", "q3")).toEqual([
      { text: "Q3", highlight: true },
      { text: " planning notes", highlight: false },
    ]);
  });

  it("highlights every occurrence of a term", () => {
    expect(highlightParts("cat and dog, cat again", "cat")).toEqual([
      { text: "cat", highlight: true },
      { text: " and dog, ", highlight: false },
      { text: "cat", highlight: true },
      { text: " again", highlight: false },
    ]);
  });

  it("highlights multiple whitespace-split terms without duplicates", () => {
    expect(highlightParts("the quick brown fox", "quick fox quick")).toEqual([
      { text: "the ", highlight: false },
      { text: "quick", highlight: true },
      { text: " brown ", highlight: false },
      { text: "fox", highlight: true },
    ]);
  });

  it("escapes regex-special punctuation in query terms", () => {
    // "c++" as a raw regex would break; it must match literally.
    expect(highlightParts("learning c++ in c++", "c++")).toEqual([
      { text: "learning ", highlight: false },
      { text: "c++", highlight: true },
      { text: " in ", highlight: false },
      { text: "c++", highlight: true },
    ]);
  });

  it("returns the whole text as plain when nothing matches", () => {
    expect(highlightParts("the quick brown fox", "zzz")).toEqual([
      { text: "the quick brown fox", highlight: false },
    ]);
  });
});

describe("HighlightedText", () => {
  it("wraps matched terms in mark elements", () => {
    render(<HighlightedText text="meeting minutes about Q3 planning" query="q3 planning" />);
    const marks = screen.getAllByText("Q3").concat(screen.getAllByText("planning"));
    expect(marks.length).toBeGreaterThan(0);
    const highlight = document.querySelector("mark");
    expect(highlight?.textContent).toBe("Q3");
    expect(highlight?.className).toContain("result-highlight");
  });

  it("does not inject HTML from the text (React children escape it)", () => {
    const { container } = render(
      <HighlightedText text={'<img src=x onerror="alert(1)"> planning'} query="planning" />,
    );
    expect(container.querySelector("img")).toBeNull();
    // The raw text is preserved verbatim as text content — never parsed.
    expect(container.textContent).toBe('<img src=x onerror="alert(1)"> planning');
  });
});
