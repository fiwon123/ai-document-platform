import { describe, expect, it } from "vitest";
import { highlightParts } from "./highlight";

describe("highlightParts", () => {
  it("returns the whole text as a plain part for an empty query", () => {
    expect(highlightParts("hello world", "")).toEqual([
      { text: "hello world", highlight: false },
    ]);
    expect(highlightParts("hello world", "   ")).toEqual([
      { text: "hello world", highlight: false },
    ]);
  });

  it("marks matching terms as highlighted", () => {
    expect(highlightParts("the quick brown fox", "quick")).toEqual([
      { text: "the ", highlight: false },
      { text: "quick", highlight: true },
      { text: " brown fox", highlight: false },
    ]);
  });

  it("matches case-insensitively", () => {
    const parts = highlightParts("Quick and QUICK", "quick");
    const highlighted = parts.filter((p) => p.highlight).map((p) => p.text);
    expect(highlighted).toEqual(["Quick", "QUICK"]);
  });

  it("de-duplicates repeated query terms", () => {
    const parts = highlightParts("cat dog", "cat cat");
    const highlighted = parts.filter((p) => p.highlight);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.text).toBe("cat");
  });

  it("regex-escapes punctuation so it cannot break the pattern", () => {
    const parts = highlightParts("works with node.js and c++", "node.js");
    const highlighted = parts.filter((p) => p.highlight).map((p) => p.text);
    expect(highlighted).toContain("node.js");
  });

  it("handles overlapping terms and multiple occurrences", () => {
    const parts = highlightParts("a b a b a", "a b");
    // Every letter should be highlighted (whitespace separators stay plain).
    const words = parts.filter((p) => p.text.trim().length > 0);
    expect(words.every((p) => p.highlight)).toBe(true);
    expect(words.map((p) => p.text).join(" ")).toBe("a b a b a");
  });

  it("returns plain single part when no term matches", () => {
    expect(highlightParts("hello", "zzz")).toEqual([
      { text: "hello", highlight: false },
    ]);
  });
});