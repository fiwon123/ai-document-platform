import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";
import { tokenizeCode } from "../utils/codeTokens";

describe("tokenizeCode", () => {
  it("colors python keywords, function calls and keeps surrounding text plain", () => {
    const tokens = tokenizeCode("def verify(secret):\n    return hmac.new(secret)", "python");
    expect(tokens.find((t) => t.type === "keyword" && t.text === "def")).toBeTruthy();
    expect(tokens.find((t) => t.type === "function" && t.text === "verify")).toBeTruthy();
    expect(tokens.find((t) => t.type === "keyword" && t.text === "return")).toBeTruthy();
    expect(tokens.find((t) => t.type === "function" && t.text === "new")).toBeTruthy();
    // Reconstructing the tokens reproduces the original source exactly.
    expect(tokens.map((t) => t.text).join("")).toBe(
      "def verify(secret):\n    return hmac.new(secret)",
    );
  });

  it("colors javascript keywords and strings without touching string content", () => {
    const tokens = tokenizeCode('const k = require("crypto");', "javascript");
    expect(tokens.find((t) => t.type === "keyword" && t.text === "const")).toBeTruthy();
    expect(tokens.find((t) => t.type === "keyword" && t.text === "require")).toBeTruthy();
    const str = tokens.find((t) => t.type === "string");
    expect(str?.text).toBe('"crypto"');
  });

  it("keeps comment text as a single comment token", () => {
    const tokens = tokenizeCode('url = "https://x" # signed', "python");
    expect(tokens.some((t) => t.type === "comment" && t.text === "# signed")).toBe(true);
    expect(tokens.some((t) => t.type === "string" && t.text === '"https://x"')).toBe(true);
  });

  it("does not colorize keyword-like text inside strings", () => {
    const tokens = tokenizeCode('f("return not a keyword")', "javascript");
    const str = tokens.find((t) => t.type === "string");
    expect(str?.text).toBe('"return not a keyword"');
    expect(tokens.filter((t) => t.type === "keyword").length).toBe(0);
  });
});

describe("CodeBlock", () => {
  it("renders the language label next to the snippet", () => {
    render(<CodeBlock code="import hashlib" language="python" />);
    expect(screen.getByText("Python")).toBeTruthy();
  });

  it("highlights tokens with their classes while preserving the full text", () => {
    const { container } = render(
      <CodeBlock code="def verify(secret):\n    return hmac.new(secret)" language="python" />,
    );
    expect(container.querySelector(".tok-keyword")?.textContent).toBe("def");
    expect(container.querySelector(".tok-function")?.textContent).toBe("verify");
    expect(container.querySelector("pre code")?.textContent).toContain("hmac.new(secret)");
  });
});
