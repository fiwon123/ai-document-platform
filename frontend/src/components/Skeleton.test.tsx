import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonCircle, SkeletonTable } from "./Skeleton";

describe("Skeleton shapes", () => {
  it("renders a hidden circle placeholder with the requested size", () => {
    const { container } = render(<SkeletonCircle size={48} />);
    const circle = container.querySelector(".skeleton-circle");
    expect(circle).toBeTruthy();
    expect(circle).toHaveAttribute("aria-hidden", "true");
    expect(circle).toHaveStyle({ width: "48px", height: "48px" });
  });

  it("renders a table skeleton with header and body rows", () => {
    const { container } = render(<SkeletonTable rows={2} columns={3} />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(container.querySelectorAll(".skeleton-table-header .skeleton")).toHaveLength(3);
    expect(container.querySelectorAll(".skeleton-table-row")).toHaveLength(2);
    expect(container.querySelectorAll(".skeleton-table-row .skeleton")).toHaveLength(6);
  });

  it("defaults to a sensible number of rows and columns", () => {
    const { container } = render(<SkeletonTable />);
    expect(container.querySelectorAll(".skeleton-table-row")).toHaveLength(3);
    expect(container.querySelectorAll(".skeleton-table-header .skeleton")).toHaveLength(4);
  });
});
