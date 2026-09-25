import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, DOCUMENT_STATUS_TONE } from "./Badge";

describe("Badge", () => {
  it("renders its label with the tone class", () => {
    const { container } = render(<Badge tone="green">Ready</Badge>);
    const badge = container.querySelector(".badge");
    expect(badge?.classList.contains("badge-green")).toBe(true);
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("uppercases via CSS, not by mutating the label", () => {
    const { container } = render(<Badge tone="blue">Processing</Badge>);
    expect(container.querySelector(".badge")?.textContent).toBe("Processing");
  });

  it("renders a leading dot when asked", () => {
    const { container } = render(<Badge tone="amber" dot>Pending</Badge>);
    expect(container.querySelector(".badge-dot")).not.toBeNull();
    expect(container.querySelector(".badge")?.classList.contains("badge-with-dot")).toBe(true);
  });

  it("omits the dot by default", () => {
    const { container } = render(<Badge tone="gray">Paused</Badge>);
    expect(container.querySelector(".badge-dot")).toBeNull();
  });

  it("passes a title tooltip through", () => {
    render(<Badge tone="blue" title="processing for 2m">Processing</Badge>);
    expect(screen.getByText("Processing").getAttribute("title")).toBe("processing for 2m");
  });

  it("merges extra className", () => {
    const { container } = render(<Badge tone="red" className="extra">Failed</Badge>);
    expect(container.querySelector(".badge")?.classList.contains("extra")).toBe(true);
  });
});

describe("DOCUMENT_STATUS_TONE", () => {
  it("maps every document status to a tone", () => {
    expect(DOCUMENT_STATUS_TONE).toMatchObject({
      pending: "amber",
      processing: "blue",
      ready: "green",
      failed: "red",
    });
  });
});