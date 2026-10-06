import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders emphasis and code inline", () => {
    render(<Markdown>This is **bold** and `code`.</Markdown>);
    expect(screen.getByText("bold")).toBeTruthy();
    expect(screen.getByText("code")).toBeTruthy();
  });

  it("renders GitHub-flavored markdown (tables, links)", () => {
    render(
      <Markdown>{"[AskDocs](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |"}</Markdown>,
    );
    expect(screen.getByRole("link", { name: "AskDocs" })).toHaveProperty(
      "href",
      "https://example.com/",
    );
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("does not render raw HTML (XSS safe)", () => {
    const { container } = render(<Markdown>{"Hello <img src=x onerror=alert(1)>"}</Markdown>);
    // Raw HTML is escaped to literal text, never inserted as a real element.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/Hello/)).toBeTruthy();
  });
});
