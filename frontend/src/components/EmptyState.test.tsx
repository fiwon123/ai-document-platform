import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(<EmptyState title="No documents" description="Upload your first file." />);
    expect(screen.getByText("No documents")).toBeTruthy();
    expect(screen.getByText("Upload your first file.")).toBeTruthy();
  });

  it("renders a link action when given a `to`", () => {
    render(
      <MemoryRouter>
        <EmptyState title="Empty" action={{ label: "Get started", to: "/app/documents" }} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Get started" });
    expect(link.getAttribute("href")).toBe("/app/documents");
  });

  it("renders a button action when given an onClick", () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: "Retry", onClick }} />);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders custom action nodes", () => {
    render(
      <EmptyState title="Empty" action={<span>custom action</span>} />,
    );
    expect(screen.getByText("custom action")).toBeTruthy();
  });

  it("renders custom children alongside the action", () => {
    render(<EmptyState title="Empty">extra copy</EmptyState>);
    expect(screen.getByText("extra copy")).toBeTruthy();
  });

  it("omits the action row when no action or children are provided", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelector(".empty-state-action")).toBeNull();
  });
});